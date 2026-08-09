import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import {
  agentHostChatResource,
  readLocalAgentHostEndpoints,
} from '../../dist/agent-host.js';

const DEFAULT_REGISTRY = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Code',
  'agent-host',
  'local-endpoint'
);
const TIMEOUT_MS = 120_000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INPUT_RESPONSES = new Set(['accept', 'decline', 'cancel']);
const ANSWER_STATES = new Set(['submitted', 'skipped']);
const ANSWER_VALUE_KINDS = new Set(['text', 'number', 'boolean', 'selected', 'selected-many']);
const AUTH_REASONS = new Set(['required', 'insufficientScope', 'expired']);
const SCENARIOS = {
  question: {
    prompt: 'Evidence capture only. Call AskUserQuestion with one single-choice question and one option. Do not call any other tool. After the question is resolved, reply with done.',
    defaultResolution: 'cancel',
  },
  'tool-deny': {
    prompt: 'Evidence capture only. Call Read once for /etc/hosts. Do not call any other tool. If permission is denied, reply with done.',
    blocker: 'tool-confirmation',
    defaultResolution: 'deny',
  },
  'plan-reject': {
    config: { mode: 'plan' },
    prompt: 'Evidence capture only. Produce a one-step plan and call ExitPlanMode. Do not call any other tool. If the plan is rejected, reply with done.',
    blocker: 'plan-review',
    defaultResolution: 'reject',
  },
  'tool-confirmation': {
    prompt: 'Evidence capture only. Call Read once for /etc/hosts. Do not call any other tool. After the tool decision, reply with done.',
    defaultResolution: 'deny',
  },
  'tool-result-confirmation': { attachOnly: true },
  authentication: { attachOnly: true },
  'plan-review': {
    config: { mode: 'plan' },
    prompt: 'Evidence capture only. Produce a one-step plan and call ExitPlanMode. Do not call any other tool. After review, reply with done.',
    defaultResolution: 'reject',
  },
  elicitation: {
    prompt: 'Evidence capture only. Call agentkeys_elicitation_form once. Do not call any other tool. After it resolves, reply with done.',
    defaultResolution: 'cancel',
  },
  'modified-files-review': {
    prompt: 'Evidence capture only. Use the edit tool to replace alpha with beta in fixture.txt. Do not call any other tool. After the tool decision, reply with done.',
    defaultResolution: 'deny',
  },
  'feedback-review': {
    prompt: 'Evidence capture only. Call viewUnreviewedComments once. Do not call any other tool. If permission is denied, reply with done.',
    defaultResolution: 'deny',
  },
};
const RESOLUTIONS = new Set([
  'accept',
  'approve',
  'cancel',
  'decline',
  'deny',
  'feedback',
  'reject',
  'submit',
]);

function usage() {
  return 'Usage: capture-agent-host-question.mjs --output <jsonl> [--session <uuid>] '
    + '[--scenario <name>] [--resolution accept|approve|cancel|decline|deny|feedback|reject|submit | --no-resolve] '
    + '[--working-directory <path>] [--timeout-ms <milliseconds>]';
}

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`unexpected argument ${argument}`);
    if (argument === '--no-resolve') {
      options.noResolve = true;
      continue;
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${argument}`);
    options[argument.slice(2)] = value;
  }
  if (!options.output) throw new Error(usage());
  options.scenario ??= 'question';
  if (!(options.scenario in SCENARIOS)) throw new Error(`unknown scenario ${options.scenario}`);
  if (options.session && !SESSION_ID.test(options.session)) throw new Error('session must be a UUID');
  if (options.noResolve && options.resolution) {
    throw new Error('--no-resolve and --resolution are mutually exclusive');
  }
  options.resolution = options.noResolve
    ? null
    : options.resolution ?? SCENARIOS[options.scenario].defaultResolution ?? null;
  if (options.resolution && !RESOLUTIONS.has(options.resolution)) {
    throw new Error(`unknown resolution ${options.resolution}`);
  }
  if (!options.session && SCENARIOS[options.scenario].attachOnly) {
    throw new Error(`scenario ${options.scenario} requires --session`);
  }
  options.timeoutMs = options['timeout-ms'] === undefined
    ? TIMEOUT_MS
    : Number(options['timeout-ms']);
  delete options['timeout-ms'];
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('timeout-ms must be a positive integer');
  }
  options.workingDirectory = path.resolve(options['working-directory'] ?? process.cwd());
  delete options['working-directory'];
  if (!fs.statSync(options.workingDirectory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('working-directory must be an existing directory');
  }
  return options;
}

function confirmationKind(toolCall) {
  if (
    toolCall?.toolName === 'viewUnreviewedComments' ||
    toolCall?.toolName?.endsWith('__viewUnreviewedComments')
  ) {
    return 'agentFeedbackReviewConfirmation';
  }
  if (Array.isArray(toolCall?.edits?.items) && toolCall.edits.items.length > 0) {
    return 'modifiedFilesConfirmation';
  }
  return undefined;
}

function safeEnum(value, allowed) {
  return allowed.has(value) ? value : 'unknown';
}

function answerStructure(answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return [];
  return Object.values(answers).map((answer) => ({
    state: safeEnum(answer?.state, ANSWER_STATES),
    valueKind: safeEnum(answer?.value?.kind, ANSWER_VALUE_KINDS),
    hasFreeformValues:
      Array.isArray(answer?.value?.freeformValues) && answer.value.freeformValues.length > 0,
  }));
}

export function trimAction(action) {
  if (action?.type === 'chat/inputCompleted') {
    const answers = answerStructure(action.answers);
    return {
      type: action.type,
      requestId: action.requestId,
      responseKind: safeEnum(action.response, INPUT_RESPONSES),
      answerCount: answers.length,
      answers,
    };
  }
  if (action?.type === 'chat/toolCallConfirmed') {
    return {
      type: action.type,
      turnId: action.turnId,
      toolCallId: action.toolCallId,
      approved: action.approved,
      hasEditedToolInput: Object.hasOwn(action, 'editedToolInput'),
      ...(action.selectedOptionId === undefined
        ? {}
        : { selectedOptionId: action.selectedOptionId }),
    };
  }
  if (action?.type === 'chat/toolCallResultConfirmed') {
    return {
      type: action.type,
      turnId: action.turnId,
      toolCallId: action.toolCallId,
      approved: action.approved,
    };
  }
  if (action?.type === 'chat/toolCallAuthResolved') {
    return {
      type: action.type,
      turnId: action.turnId,
      toolCallId: action.toolCallId,
    };
  }
  if (action?.type === 'chat/turnCancelled') {
    return { type: action.type, turnId: action.turnId };
  }
  return null;
}

export function trimState(state) {
  const trimTurn = (turn) => {
    if (!turn || typeof turn !== 'object') return undefined;
    return {
      id: turn.id,
      state: turn.state,
      responseParts: Array.isArray(turn.responseParts)
        ? turn.responseParts.flatMap((part) => {
            if (part?.kind === 'inputRequest') {
              const responseKind = typeof part.response === 'string'
                ? safeEnum(part.response, INPUT_RESPONSES)
                : part.response?.kind;
              return [{
                kind: part.kind,
                request: {
                  id: part.request?.id,
                  purpose: part.request?.purpose,
                  planReview: part.request?.planReview === undefined ? undefined : true,
                  url: part.request?.url === undefined ? undefined : true,
                },
                ...(part.response === undefined ? {} : { response: { kind: responseKind } }),
              }];
            }
            if (part?.kind === 'toolCall') {
              const kind = confirmationKind(part.toolCall);
              const authReason = safeEnum(part.toolCall?.auth?.reason, AUTH_REASONS);
              return [{
                kind: part.kind,
                toolCall: {
                  toolCallId: part.toolCall?.toolCallId,
                  toolName: part.toolCall?.toolName,
                  status: part.toolCall?.status,
                  ...(kind ? { confirmationKind: kind } : {}),
                  ...(part.toolCall?.contributor?.kind === 'mcp'
                    ? { contributorKind: 'mcp' }
                    : {}),
                  ...(part.toolCall?.status === 'auth-required'
                    ? {
                        auth: {
                          reasonKind: authReason,
                          requiredScopeCount: Array.isArray(part.toolCall?.auth?.requiredScopes)
                            ? part.toolCall.auth.requiredScopes.length
                            : 0,
                        },
                      }
                    : {}),
                  _meta: {
                    autoApproveBySetting: part.toolCall?._meta?.autoApproveBySetting,
                  },
                },
              }];
            }
            return part && typeof part === 'object'
              ? [{ kind: typeof part.kind === 'string' ? part.kind : undefined }]
              : [{ kind: undefined }];
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

export function protocolTruth(state) {
  if (typeof state?.status !== 'number') throw new Error('chat snapshot has no numeric status');
  const executionStatus = state.status & 31;
  return {
    hasActiveRequest: Boolean(state.activeTurn),
    requestInProgress: executionStatus === 8,
    awaitsUserInput: executionStatus === 24,
  };
}

function inputKind(part, parts = []) {
  if (part?.request && 'planReview' in part.request) return 'plan-review';
  if (part?.request?.purpose === 'planReview') return 'plan-review';
  if (part?.request?.purpose === 'elicitation') return 'elicitation';
  if (part?.request?.url !== undefined) return 'elicitation';
  if (parts.some((candidate) =>
    candidate?.kind === 'toolCall' &&
    candidate.toolCall?.status === 'running' &&
    candidate.toolCall?.contributor?.kind === 'mcp'
  )) {
    return 'elicitation';
  }
  return 'question';
}

function blockerKind(part, parts) {
  if (part?.kind === 'inputRequest' && part.response === undefined) return inputKind(part, parts);
  if (part?.kind !== 'toolCall') return null;
  const toolCall = part.toolCall;
  if (
    toolCall?.status === 'pending-confirmation' &&
    toolCall?._meta?.autoApproveBySetting !== true
  ) {
    const kind = confirmationKind(toolCall);
    if (kind === 'modifiedFilesConfirmation') return 'modified-files-review';
    if (kind === 'agentFeedbackReviewConfirmation') return 'feedback-review';
    return 'tool-confirmation';
  }
  if (toolCall?.status === 'pending-result-confirmation') return 'tool-result-confirmation';
  if (toolCall?.status === 'auth-required') return 'authentication';
  return null;
}

function sourceId(part, index) {
  if (part?.kind === 'inputRequest') return part.request?.id ?? `position-${index}`;
  if (part?.kind === 'toolCall') return part.toolCall?.toolCallId ?? `position-${index}`;
  return `position-${index}`;
}

export function findScenarioBlocker(state, scenarioName) {
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) throw new Error(`unknown scenario ${scenarioName}`);
  const expectedKind = scenario.blocker ?? scenarioName;
  const parts = state?.activeTurn?.responseParts;
  if (!Array.isArray(parts)) return null;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (blockerKind(part, parts) === expectedKind) {
      return {
        kind: expectedKind,
        responsePartKind: part.kind,
        sourceId: sourceId(part, index),
        part,
      };
    }
  }
  return null;
}

function matchingPart(state, blocker) {
  const turn = state?.activeTurn ?? (Array.isArray(state?.turns) ? state.turns.at(-1) : undefined);
  const parts = turn?.responseParts;
  if (!Array.isArray(parts)) return null;
  return parts.find((part, index) =>
    part?.kind === blocker.responsePartKind && sourceId(part, index) === blocker.sourceId
  ) ?? null;
}

export function blockerResolved(state, blocker) {
  if (!protocolTruth(state).hasActiveRequest) return true;
  const part = matchingPart(state, blocker);
  if (!part) return true;
  if (part.kind === 'inputRequest') return part.response !== undefined;
  if (part.kind === 'toolCall') return blockerKind(part) !== blocker.kind;
  return true;
}

export function actionMatchesBlocker(action, blocker, turnId) {
  if (!action || !blocker) return false;
  if (action.type === 'chat/turnCancelled') return action.turnId === turnId;
  if (blocker.responsePartKind === 'inputRequest') {
    return action.type === 'chat/inputCompleted' && action.requestId === blocker.sourceId;
  }
  if (blocker.responsePartKind !== 'toolCall' || action.toolCallId !== blocker.sourceId) {
    return false;
  }
  return [
    'chat/toolCallConfirmed',
    'chat/toolCallResultConfirmed',
    'chat/toolCallAuthResolved',
  ].includes(action.type);
}

function selectedQuestionAnswer(request, freeformValue) {
  const question = request?.questions?.[0];
  const option = question?.options?.[0];
  if (typeof question?.id !== 'string') throw new Error('input request has no question id');
  if (option?.id === undefined) {
    if (!freeformValue) throw new Error('input request has no selectable option');
    return {
      [question.id]: { state: 'submitted', value: { kind: 'text', value: freeformValue } },
    };
  }
  const value = question.kind === 'multi-select'
    ? { kind: 'selected-many', value: [option.id] }
    : { kind: 'selected', value: option.id };
  if (freeformValue) value.freeformValues = [freeformValue];
  return { [question.id]: { state: 'submitted', value } };
}

function planReviewAnswer(request, feedback) {
  const review = request?.planReview;
  const action = review?.actions?.find((candidate) =>
    candidate?.id === review.recommendedAction
  ) ?? review?.actions?.[0];
  if (typeof review?.answerQuestionId !== 'string') {
    throw new Error('plan review has no answer question id');
  }
  if (!action?.id) {
    if (!feedback) throw new Error('plan review has no selectable action');
    return {
      [review.answerQuestionId]: {
        state: 'submitted',
        value: { kind: 'text', value: feedback },
      },
    };
  }
  return {
    [review.answerQuestionId]: {
      state: 'submitted',
      value: {
        kind: 'selected',
        value: action.id,
        ...(feedback ? { freeformValues: [feedback] } : {}),
      },
    },
  };
}

export function resolutionAction(resolution, activeTurn, blocker) {
  if (resolution === 'deny') {
    if (blocker.responsePartKind !== 'toolCall') {
      throw new Error('deny resolution requires a tool-call blocker');
    }
    return {
      type: 'chat/toolCallConfirmed',
      turnId: activeTurn.id,
      toolCallId: blocker.sourceId,
      approved: false,
      reason: 'user-denied',
    };
  }
  if (resolution === 'approve' && blocker.responsePartKind === 'toolCall') {
    if (blocker.kind === 'tool-result-confirmation') {
      return {
        type: 'chat/toolCallResultConfirmed',
        turnId: activeTurn.id,
        toolCallId: blocker.sourceId,
        approved: true,
      };
    }
    return {
      type: 'chat/toolCallConfirmed',
      turnId: activeTurn.id,
      toolCallId: blocker.sourceId,
      approved: true,
      confirmed: 'user-action',
    };
  }
  if (resolution === 'reject' && blocker.kind === 'tool-result-confirmation') {
    return {
      type: 'chat/toolCallResultConfirmed',
      turnId: activeTurn.id,
      toolCallId: blocker.sourceId,
      approved: false,
    };
  }
  if (resolution === 'submit') {
    if (blocker.kind !== 'question') throw new Error('submit requires a question blocker');
    return {
      type: 'chat/inputCompleted',
      requestId: blocker.sourceId,
      response: 'accept',
      answers: selectedQuestionAnswer(blocker.part.request),
    };
  }
  if (resolution === 'approve' && blocker.kind === 'plan-review') {
    return {
      type: 'chat/inputCompleted',
      requestId: blocker.sourceId,
      response: 'accept',
      answers: planReviewAnswer(blocker.part.request),
    };
  }
  if (resolution === 'feedback') {
    if (blocker.kind !== 'plan-review') throw new Error('feedback requires a plan-review blocker');
    return {
      type: 'chat/inputCompleted',
      requestId: blocker.sourceId,
      response: 'accept',
      answers: planReviewAnswer(blocker.part.request, 'Revise the single step.'),
    };
  }
  if (resolution === 'accept' || resolution === 'decline') {
    if (blocker.kind !== 'elicitation') {
      throw new Error(`${resolution} requires an elicitation blocker`);
    }
    return {
      type: 'chat/inputCompleted',
      requestId: blocker.sourceId,
      response: resolution,
      ...(resolution === 'accept' && blocker.part.request?.questions?.length
        ? { answers: selectedQuestionAnswer(blocker.part.request) }
        : {}),
    };
  }
  if (resolution === 'cancel' || resolution === 'reject') {
    if (blocker.responsePartKind !== 'inputRequest') {
      throw new Error(`${resolution} resolution requires an input-request blocker`);
    }
    return {
      type: 'chat/inputCompleted',
      requestId: blocker.sourceId,
      response: 'cancel',
    };
  }
  return null;
}

export async function main() {
  const options = parseArgs(process.argv.slice(2));
  const output = path.resolve(options.output);
  if (fs.existsSync(output)) throw new Error(`output already exists: ${output}`);
  const endpoint = readLocalAgentHostEndpoints(options.registry ?? DEFAULT_REGISTRY)[0];
  if (!endpoint) throw new Error('no live local Agent Host endpoint');

  const sessionId = options.session ?? randomUUID();
  const sessionChannel = `copilotcli:/${sessionId}`;
  const chatChannel = agentHostChatResource(sessionId);
  const clientId = `agentkeys-evidence-${process.pid}-${randomUUID()}`;
  let socket;
  let requestId = 0;
  let clientSeq = 0;
  let waitingCaptured = false;
  let resolvedCaptured = false;
  let terminalCaptured = false;
  let capturedBlocker;
  let stateTurnId;
  let refreshPromise = Promise.resolve();
  const pending = new Map();

  const close = () => {
    if (socket?.readyState < WebSocket.CLOSING) socket.close();
  };
  const timeout = setTimeout(() => {
    close();
    process.stderr.write('capture timed out\n');
    process.exitCode = 2;
  }, options.timeoutMs);

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
    const recordAction = (action) => {
      const trimmed = trimAction(action);
      if (!trimmed) return;
      fs.appendFileSync(output, `${JSON.stringify({
        type: 'agent-host.action',
        stage: 'resolution-action',
        timestamp: new Date().toISOString(),
        action: trimmed,
      })}\n`);
    };
    const inspect = (state) => {
      const truth = protocolTruth(state);
      const activeTurn = state?.activeTurn;
      const blocker = findScenarioBlocker(state, options.scenario);

      if (!waitingCaptured && blocker) {
        if (!truth.hasActiveRequest || !truth.awaitsUserInput || truth.requestInProgress) {
          throw new Error('blocker did not set the authoritative waiting status');
        }
        waitingCaptured = true;
        capturedBlocker = blocker;
        stateTurnId = activeTurn.id;
        record('waiting', state, truth);
        const action = resolutionAction(options.resolution, activeTurn, blocker);
        if (action) dispatch(action);
        return;
      }
      if (waitingCaptured && !resolvedCaptured && !truth.awaitsUserInput) {
        if (!blockerResolved(state, capturedBlocker)) {
          throw new Error('waiting status cleared before the captured blocker resolved');
        }
        resolvedCaptured = true;
        terminalCaptured = !truth.hasActiveRequest;
        record(terminalCaptured ? 'terminal' : 'resolved', state, truth);
      }
      if (resolvedCaptured && !terminalCaptured && !truth.hasActiveRequest) {
        if (truth.requestInProgress || truth.awaitsUserInput) {
          throw new Error('terminal snapshot retained active execution bits');
        }
        terminalCaptured = true;
        record('terminal', state, truth);
      }
      if (terminalCaptured) {
        clearTimeout(timeout);
        close();
      }
    };
    const refresh = () => {
      refreshPromise = refreshPromise.then(async () => {
        if (terminalCaptured || socket.readyState !== WebSocket.OPEN) return;
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
      if (message.method === 'action' && message.params?.channel === chatChannel) {
        if (
          waitingCaptured &&
          actionMatchesBlocker(message.params.action, capturedBlocker, stateTurnId)
        ) {
          recordAction(message.params.action);
        }
        refresh();
      }
    });

    await request('initialize', {
      channel: 'ahp-root://',
      protocolVersions: [endpoint.protocolVersion],
      clientId,
      clientInfo: { name: 'AgentKeys evidence capture', version: '0.1.0' },
      initialSubscriptions: [],
    });
    if (!options.session) {
      await request('createSession', {
        channel: sessionChannel,
        provider: 'copilotcli',
        workingDirectories: [pathToFileURL(options.workingDirectory).toString()],
        config: SCENARIOS[options.scenario].config,
      });
    }
    const initial = await request('subscribe', { channel: chatChannel });
    if (!initial?.snapshot?.state) throw new Error('chat subscription returned no snapshot');
    process.stdout.write(`${sessionId}\t${options.scenario}\n`);
    inspect(initial.snapshot.state);
    if (!options.session) {
      dispatch({
        type: 'chat/turnStarted',
        turnId: randomUUID(),
        startedAt: new Date().toISOString(),
        message: {
          text: SCENARIOS[options.scenario].prompt,
        },
      });
    }
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();