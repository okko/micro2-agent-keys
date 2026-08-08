import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import {
  agentHostChatResource,
  readLocalAgentHostEndpoints,
} from '../dist/agent-host.js';

const DEFAULT_REGISTRY = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Code',
  'agent-host',
  'local-endpoint'
);
const TIMEOUT_MS = 120_000;
const SCENARIOS = {
  question: {
    prompt: 'Evidence capture only. Call AskUserQuestion with one single-choice question and one option. Do not call any other tool. After the question is resolved, reply with done.',
  },
  'tool-deny': {
    prompt: 'Evidence capture only. Call Read once for /etc/hosts. Do not call any other tool. If permission is denied, reply with done.',
  },
  'plan-reject': {
    config: { mode: 'plan' },
    prompt: 'Evidence capture only. Produce a one-step plan and call ExitPlanMode. Do not call any other tool. If the plan is rejected, reply with done.',
  },
};

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`unexpected argument ${argument}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${argument}`);
    options[argument.slice(2)] = value;
  }
  if (!options.output) {
    throw new Error(
      'Usage: capture-agent-host-question.mjs --output <jsonl> [--scenario question|tool-deny|plan-reject]'
    );
  }
  options.scenario ??= 'question';
  if (!(options.scenario in SCENARIOS)) throw new Error(`unknown scenario ${options.scenario}`);
  return options;
}

function trimState(state) {
  const trimTurn = (turn) => {
    if (!turn || typeof turn !== 'object') return undefined;
    return {
      id: turn.id,
      state: turn.state,
      responseParts: Array.isArray(turn.responseParts)
        ? turn.responseParts.flatMap((part) => {
            if (part?.kind === 'inputRequest') {
              return [{
                kind: part.kind,
                request: {
                  id: part.request?.id,
                  purpose: part.request?.purpose,
                  planReview: part.request?.planReview === undefined ? undefined : true,
                },
                ...(part.response === undefined ? {} : { response: { kind: part.response?.kind } }),
              }];
            }
            if (part?.kind === 'toolCall') {
              return [{
                kind: part.kind,
                toolCall: {
                  toolCallId: part.toolCall?.toolCallId,
                  toolName: part.toolCall?.toolName,
                  status: part.toolCall?.status,
                  _meta: {
                    autoApproveBySetting: part.toolCall?._meta?.autoApproveBySetting,
                  },
                },
              }];
            }
            return [];
          })
        : [],
    };
  };
  const latestTurn = Array.isArray(state?.turns) ? state.turns.at(-1) : undefined;
  return {
    status: state?.status,
    activeTurn: trimTurn(state?.activeTurn),
    turns: latestTurn ? [trimTurn(latestTurn)] : [],
  };
}

function protocolTruth(state) {
  if (typeof state?.status !== 'number') throw new Error('chat snapshot has no numeric status');
  const executionStatus = state.status & 31;
  return {
    hasActiveRequest: Boolean(state.activeTurn),
    requestInProgress: executionStatus === 8,
    awaitsUserInput: executionStatus === 24,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const output = path.resolve(options.output);
  if (fs.existsSync(output)) throw new Error(`output already exists: ${output}`);
  const endpoint = readLocalAgentHostEndpoints(options.registry ?? DEFAULT_REGISTRY)[0];
  if (!endpoint) throw new Error('no live local Agent Host endpoint');

  const sessionId = randomUUID();
  const sessionChannel = `copilotcli:/${sessionId}`;
  const chatChannel = agentHostChatResource(sessionId);
  const clientId = `agentkeys-evidence-${process.pid}-${randomUUID()}`;
  let socket;
  let requestId = 0;
  let clientSeq = 0;
  let waitingCaptured = false;
  let resolvedCaptured = false;
  let refreshPromise = Promise.resolve();
  const pending = new Map();

  const close = () => {
    if (socket?.readyState < WebSocket.CLOSING) socket.close();
  };
  const timeout = setTimeout(() => {
    close();
    process.stderr.write('capture timed out\n');
    process.exitCode = 2;
  }, TIMEOUT_MS);

  try {
    const address = `ws+unix:${endpoint.socketPath}:/?tkn=${encodeURIComponent(endpoint.connectionToken)}`;
    socket = new WebSocket(address);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    const request = (method, params) => new Promise((resolve, reject) => {
      const id = ++requestId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
    const dispatch = (action) => {
      socket.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'dispatchAction',
        params: { channel: chatChannel, clientSeq: ++clientSeq, action },
      }));
    };
    const record = (stage, state, truth) => {
      fs.appendFileSync(output, `${JSON.stringify({
        type: 'agent-host.snapshot',
        stage,
        timestamp: new Date().toISOString(),
        truth,
        state: trimState(state),
      })}\n`);
    };
    const inspect = (state) => {
      const truth = protocolTruth(state);
      const activeTurn = state?.activeTurn;
      const input = Array.isArray(activeTurn?.responseParts)
        ? activeTurn.responseParts.find((part) =>
            part?.kind === 'inputRequest' && part.response === undefined
          )
        : undefined;
      const tool = Array.isArray(activeTurn?.responseParts)
        ? activeTurn.responseParts.find((part) =>
            part?.kind === 'toolCall' &&
            part.toolCall?.status === 'pending-confirmation' &&
            part.toolCall?._meta?.autoApproveBySetting !== true
          )
        : undefined;
      const blocker = options.scenario === 'tool-deny'
        ? tool
        : options.scenario === 'plan-reject'
          ? input?.request?.planReview === undefined ? undefined : input
          : input;

      if (!waitingCaptured && blocker) {
        if (!truth.hasActiveRequest || !truth.awaitsUserInput || truth.requestInProgress) {
          throw new Error('blocker did not set the authoritative waiting status');
        }
        waitingCaptured = true;
        record('waiting', state, truth);
        if (options.scenario !== 'tool-deny') {
          dispatch({
            type: 'chat/inputCompleted',
            requestId: input.request.id,
            response: 'cancel',
          });
        } else {
          dispatch({
            type: 'chat/toolCallConfirmed',
            turnId: activeTurn.id,
            toolCallId: tool.toolCall.toolCallId,
            approved: false,
            reason: 'user-denied',
          });
        }
        return;
      }
      if (waitingCaptured && !resolvedCaptured && !truth.awaitsUserInput) {
        resolvedCaptured = true;
        record(truth.hasActiveRequest ? 'resolved' : 'terminal', state, truth);
      }
      if (resolvedCaptured && !truth.hasActiveRequest) {
        record('terminal', state, truth);
        clearTimeout(timeout);
        close();
        process.stdout.write(`${sessionId}\t${options.scenario}\n`);
      }
    };
    const refresh = () => {
      refreshPromise = refreshPromise.then(async () => {
        const result = await request('subscribe', { channel: chatChannel });
        if (result?.snapshot?.state) inspect(result.snapshot.state);
      });
    };

    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (typeof message.id === 'number') {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(`Agent Host protocol error ${message.error.code}`));
        else waiter.resolve(message.result);
        return;
      }
      if (message.method === 'action' && message.params?.channel === chatChannel) refresh();
    });

    await request('initialize', {
      channel: 'ahp-root://',
      protocolVersions: [endpoint.protocolVersion],
      clientId,
      clientInfo: { name: 'AgentKeys evidence capture', version: '0.1.0' },
      initialSubscriptions: [],
    });
    await request('createSession', {
      channel: sessionChannel,
      provider: 'copilotcli',
      workingDirectories: [pathToFileURL(process.cwd()).toString()],
      config: SCENARIOS[options.scenario].config,
    });
    const initial = await request('subscribe', { channel: chatChannel });
    if (!initial?.snapshot?.state) throw new Error('chat subscription returned no snapshot');
    inspect(initial.snapshot.state);
    dispatch({
      type: 'chat/turnStarted',
      turnId: randomUUID(),
      startedAt: new Date().toISOString(),
      message: {
        text: SCENARIOS[options.scenario].prompt,
      },
    });
    await new Promise((resolve, reject) => {
      socket.once('close', resolve);
      socket.once('error', reject);
    });
    await refreshPromise;
    if (!waitingCaptured || !resolvedCaptured) throw new Error('requested lifecycle was not captured');
  } finally {
    clearTimeout(timeout);
    close();
  }
}

await main();