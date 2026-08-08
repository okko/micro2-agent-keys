import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  actionMatchesBlocker,
  blockerResolved,
  findScenarioBlocker,
  parseArgs,
  protocolTruth,
  resolutionAction,
  trimAction,
  trimState,
} from '../scripts/capture-agent-host-question.mjs';

const SESSION_ID = '00000000-0000-4000-8000-000000000000';

function stateWith(part, status = 24) {
  return {
    status,
    activeTurn: {
      id: 'turn-1',
      state: 'in-progress',
      responseParts: [part],
    },
  };
}

test('parses isolated and passive capture modes', () => {
  assert.deepEqual(parseArgs(['--output', 'capture.jsonl']), {
    output: 'capture.jsonl',
    scenario: 'question',
    resolution: 'cancel',
    timeoutMs: 120000,
    workingDirectory: process.cwd(),
  });
  assert.deepEqual(parseArgs([
    '--output', 'capture.jsonl',
    '--session', SESSION_ID,
    '--scenario', 'authentication',
    '--no-resolve',
  ]), {
    output: 'capture.jsonl',
    session: SESSION_ID,
    scenario: 'authentication',
    noResolve: true,
    resolution: null,
    timeoutMs: 120000,
    workingDirectory: process.cwd(),
  });
  assert.throws(
    () => parseArgs(['--output', 'capture.jsonl', '--scenario', 'authentication']),
    /requires --session/
  );
  assert.throws(
    () => parseArgs(['--output', 'capture.jsonl', '--no-resolve', '--resolution', 'cancel']),
    /mutually exclusive/
  );
  assert.equal(
    parseArgs(['--output', 'capture.jsonl', '--timeout-ms', '600000']).timeoutMs,
    600000
  );
  assert.throws(
    () => parseArgs(['--output', 'capture.jsonl', '--timeout-ms', 'forever']),
    /positive integer/
  );
  assert.equal(
    parseArgs(['--output', 'capture.jsonl', '--working-directory', '.']).workingDirectory,
    path.resolve('.')
  );
  assert.throws(
    () => parseArgs(['--output', 'capture.jsonl', '--working-directory', './missing-directory']),
    /existing directory/
  );
});

test('recognizes every supported unresolved blocker kind', () => {
  const cases = [
    ['question', { kind: 'inputRequest', request: { id: 'question', purpose: 'askUser' } }],
    ['plan-review', { kind: 'inputRequest', request: { id: 'plan', planReview: {} } }],
    ['elicitation', { kind: 'inputRequest', request: { id: 'form', purpose: 'elicitation' } }],
    ['tool-confirmation', {
      kind: 'toolCall',
      toolCall: { toolCallId: 'pre', status: 'pending-confirmation' },
    }],
    ['tool-result-confirmation', {
      kind: 'toolCall',
      toolCall: { toolCallId: 'post', status: 'pending-result-confirmation' },
    }],
    ['authentication', {
      kind: 'toolCall',
      toolCall: { toolCallId: 'auth', status: 'auth-required' },
    }],
    ['modified-files-review', {
      kind: 'toolCall',
      toolCall: {
        toolCallId: 'files',
        toolName: 'edit',
        status: 'pending-confirmation',
        edits: { items: [{}] },
      },
    }],
    ['feedback-review', {
      kind: 'toolCall',
      toolCall: {
        toolCallId: 'feedback',
        toolName: 'provider__viewUnreviewedComments',
        status: 'pending-confirmation',
      },
    }],
  ];

  for (const [scenario, part] of cases) {
    const blocker = findScenarioBlocker(stateWith(part), scenario);
    assert.equal(blocker?.kind, scenario, scenario);
    assert.equal(blocker?.sourceId, part.request?.id ?? part.toolCall?.toolCallId, scenario);
  }

  const autoApproved = stateWith({
    kind: 'toolCall',
    toolCall: {
      toolCallId: 'auto',
      status: 'pending-confirmation',
      _meta: { autoApproveBySetting: true },
    },
  });
  assert.equal(findScenarioBlocker(autoApproved, 'tool-confirmation'), null);

  const installedFormShape = {
    status: 24,
    activeTurn: {
      id: 'turn-1',
      responseParts: [
        {
          kind: 'toolCall',
          toolCall: {
            toolCallId: 'mcp-tool',
            status: 'running',
            contributor: { kind: 'mcp' },
          },
        },
        { kind: 'inputRequest', request: { id: 'form-without-purpose' } },
      ],
    },
  };
  assert.equal(
    findScenarioBlocker(installedFormShape, 'elicitation')?.sourceId,
    'form-without-purpose'
  );
  assert.equal(findScenarioBlocker(stateWith({
    kind: 'inputRequest',
    request: { id: 'url-without-purpose', url: 'http://127.0.0.1/evidence' },
  }), 'elicitation')?.sourceId, 'url-without-purpose');
});

test('requires the correlated blocker to resolve', () => {
  const waiting = stateWith({
    kind: 'toolCall',
    toolCall: { toolCallId: 'tool-1', status: 'pending-result-confirmation' },
  });
  const blocker = findScenarioBlocker(waiting, 'tool-result-confirmation');

  assert.equal(blockerResolved(waiting, blocker), false);
  assert.equal(blockerResolved(stateWith({
    kind: 'toolCall',
    toolCall: { toolCallId: 'tool-1', status: 'completed' },
  }, 8), blocker), true);
  assert.equal(blockerResolved({ status: 1, turns: [] }, blocker), true);
  assert.equal(blockerResolved({
    status: 1,
    turns: [{
      id: 'turn-1',
      responseParts: [{
        kind: 'toolCall',
        toolCall: { toolCallId: 'tool-1', status: 'pending-result-confirmation' },
      }],
    }],
  }, blocker), true);
});

test('trims unknown parts and only allowlisted confirmation metadata', () => {
  const state = {
    status: 24,
    activeTurn: {
      id: 'turn-1',
      responseParts: [
        { kind: 'futureInput', privateText: 'secret' },
        {
          kind: 'toolCall',
          toolCall: {
            toolCallId: 'tool-1',
            toolName: 'edit',
            status: 'pending-confirmation',
            edits: { items: [{ privatePath: '/private' }] },
            privateInput: 'secret',
          },
        },
      ],
    },
  };
  const trimmed = trimState(state);

  assert.deepEqual(trimmed.activeTurn.responseParts[0], { kind: 'futureInput' });
  assert.equal(
    trimmed.activeTurn.responseParts[1].toolCall.confirmationKind,
    'modifiedFilesConfirmation'
  );
  assert.doesNotMatch(JSON.stringify(trimmed), /privateText|privateInput|secret/);
});

test('trims MCP contributor and authentication metadata without secrets', () => {
  const trimmed = trimState(stateWith({
    kind: 'toolCall',
    toolCall: {
      toolCallId: 'auth-tool',
      toolName: 'mcp-tool',
      status: 'auth-required',
      contributor: { kind: 'mcp', privateName: 'account' },
      auth: {
        reason: 'insufficientScope',
        requiredScopes: ['private:scope'],
        resource: 'https://private.example',
      },
    },
  }));
  const tool = trimmed.activeTurn.responseParts[0].toolCall;

  assert.equal(tool.contributorKind, 'mcp');
  assert.deepEqual(tool.auth, { reasonKind: 'insufficientScope', requiredScopeCount: 1 });
  assert.doesNotMatch(JSON.stringify(trimmed), /private:scope|private\.example|account/);
});

test('retains only privacy-safe resolution action structure', () => {
  const input = trimAction({
    type: 'chat/inputCompleted',
    requestId: 'request-1',
    response: 'accept',
    answers: {
      privateQuestion: {
        state: 'submitted',
        value: {
          kind: 'selected',
          value: 'private option',
          freeformValues: ['private feedback'],
        },
      },
    },
  });
  assert.deepEqual(input, {
    type: 'chat/inputCompleted',
    requestId: 'request-1',
    responseKind: 'accept',
    answerCount: 1,
    answers: [{ state: 'submitted', valueKind: 'selected', hasFreeformValues: true }],
  });

  const tool = trimAction({
    type: 'chat/toolCallConfirmed',
    turnId: 'turn-1',
    toolCallId: 'tool-1',
    approved: true,
    editedToolInput: 'private input',
  });
  assert.deepEqual(tool, {
    type: 'chat/toolCallConfirmed',
    turnId: 'turn-1',
    toolCallId: 'tool-1',
    approved: true,
    hasEditedToolInput: true,
  });
  assert.doesNotMatch(
    JSON.stringify([input, tool]),
    /privateQuestion|private option|private feedback|private input/
  );
});

test('correlates resolution actions with the captured blocker', () => {
  const input = findScenarioBlocker(stateWith({
    kind: 'inputRequest',
    request: { id: 'question-1', purpose: 'askUser' },
  }), 'question');
  assert.equal(actionMatchesBlocker({
    type: 'chat/inputCompleted',
    requestId: 'question-1',
  }, input, 'turn-1'), true);
  assert.equal(actionMatchesBlocker({
    type: 'chat/inputCompleted',
    requestId: 'other',
  }, input, 'turn-1'), false);
  assert.equal(actionMatchesBlocker({
    type: 'chat/turnCancelled',
    turnId: 'turn-1',
  }, input, 'turn-1'), true);

  const tool = findScenarioBlocker(stateWith({
    kind: 'toolCall',
    toolCall: { toolCallId: 'tool-1', status: 'pending-confirmation' },
  }), 'tool-confirmation');
  assert.equal(actionMatchesBlocker({
    type: 'chat/toolCallConfirmed',
    toolCallId: 'tool-1',
  }, tool, 'turn-1'), true);
  assert.equal(actionMatchesBlocker({
    type: 'chat/turnCancelled',
    turnId: 'turn-1',
  }, tool, 'turn-1'), true);
});

test('builds source-verified submit and plan-review actions', () => {
  const questionState = stateWith({
    kind: 'inputRequest',
    request: {
      id: 'question-1',
      purpose: 'askUser',
      questions: [{
        id: 'choice',
        kind: 'single-select',
        options: [{ id: 'first' }],
      }],
    },
  });
  assert.deepEqual(
    resolutionAction('submit', questionState.activeTurn, findScenarioBlocker(questionState, 'question')),
    {
      type: 'chat/inputCompleted',
      requestId: 'question-1',
      response: 'accept',
      answers: {
        choice: { state: 'submitted', value: { kind: 'selected', value: 'first' } },
      },
    }
  );

  const planState = stateWith({
    kind: 'inputRequest',
    request: {
      id: 'plan-1',
      planReview: {
        answerQuestionId: 'decision',
        recommendedAction: 'interactive',
        actions: [
          { id: 'revise' },
          { id: 'interactive' },
        ],
      },
    },
  });
  const blocker = findScenarioBlocker(planState, 'plan-review');
  const approved = resolutionAction('approve', planState.activeTurn, blocker);
  const feedback = resolutionAction('feedback', planState.activeTurn, blocker);
  assert.deepEqual(approved.answers, {
    decision: { state: 'submitted', value: { kind: 'selected', value: 'interactive' } },
  });
  assert.deepEqual(feedback.answers.decision.value.kind, 'selected');
  assert.equal(feedback.answers.decision.value.freeformValues.length, 1);
});

test('builds source-verified post-tool review actions', () => {
  const state = stateWith({
    kind: 'toolCall',
    toolCall: { toolCallId: 'result-1', status: 'pending-result-confirmation' },
  });
  const blocker = findScenarioBlocker(state, 'tool-result-confirmation');

  assert.deepEqual(resolutionAction('approve', state.activeTurn, blocker), {
    type: 'chat/toolCallResultConfirmed',
    turnId: 'turn-1',
    toolCallId: 'result-1',
    approved: true,
  });
  assert.deepEqual(resolutionAction('reject', state.activeTurn, blocker), {
    type: 'chat/toolCallResultConfirmed',
    turnId: 'turn-1',
    toolCallId: 'result-1',
    approved: false,
  });
});

test('builds spec-verified elicitation actions', () => {
  const state = stateWith({
    kind: 'inputRequest',
    request: {
      id: 'elicitation-1',
      purpose: 'elicitation',
      questions: [{
        id: 'answer',
        kind: 'single-select',
        options: [{ id: 'continue' }],
      }],
    },
  });
  const blocker = findScenarioBlocker(state, 'elicitation');

  assert.deepEqual(resolutionAction('accept', state.activeTurn, blocker), {
    type: 'chat/inputCompleted',
    requestId: 'elicitation-1',
    response: 'accept',
    answers: {
      answer: { state: 'submitted', value: { kind: 'selected', value: 'continue' } },
    },
  });
  assert.deepEqual(resolutionAction('decline', state.activeTurn, blocker), {
    type: 'chat/inputCompleted',
    requestId: 'elicitation-1',
    response: 'decline',
  });
});

test('derives authoritative Agent Host execution truth', () => {
  assert.deepEqual(protocolTruth({ status: 24, activeTurn: {} }), {
    hasActiveRequest: true,
    requestInProgress: false,
    awaitsUserInput: true,
  });
  assert.deepEqual(protocolTruth({ status: 8, activeTurn: {} }), {
    hasActiveRequest: true,
    requestInProgress: true,
    awaitsUserInput: false,
  });
  assert.deepEqual(protocolTruth({ status: 1 }), {
    hasActiveRequest: false,
    requestInProgress: false,
    awaitsUserInput: false,
  });
});