import type { GetDiscovery, ManagerContext } from './types.js';
import { z } from 'zod';

const estimateSchema = z
  .object({
    inputTokensPerCall: z.number().int().min(0).max(1_000_000),
    outputTokensPerCall: z.number().int().min(0).max(1_000_000),
    invocations: z
      .array(
        z.object({ agentId: z.string().uuid(), count: z.number().int().min(0).max(1000) }).strict(),
      )
      .max(200),
  })
  .strict();
function list(value) {
  if (Array.isArray(value))
    return value
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
  if (typeof value === 'string')
    return value
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  return [];
}
function safeCost(value) {
  if (!value || typeof value !== 'object') return null;
  const input = value.input;
  const output = value.output;
  if (
    typeof input !== 'number' ||
    input < 0 ||
    !Number.isFinite(output) ||
    typeof output !== 'number' ||
    output < 0
  )
    return null;
  return { input, output };
}
function field(agent, name) {
  return agent.effectiveFields?.[name]?.value;
}
function nodeId(kind, id) {
  return `${kind}:${id}`;
}
function modelReference(value) {
  if (typeof value !== 'string' || value === 'inherit' || !value.includes('/')) return null;
  return value.trim();
}

export function createAnalysisService(options: {
  getDiscovery: GetDiscovery;
  getRuntimeModels?: () => any[];
}) {
  const { getDiscovery, getRuntimeModels = () => [] } = options;
  async function buildGraph() {
    const discovery = await getDiscovery();
    const resources = discovery.getResources();
    const agents = resources.filter((resource) => resource.kind === 'agent');
    const skills = resources.filter((resource) => resource.kind === 'skill');
    const models = resources.filter((resource) => resource.kind === 'model');
    const instructions = discovery
      .getInstructionSources()
      .filter((source) => ['global', 'project', 'ancestor'].includes(source.scope));
    const environment = discovery.getEnvironment();
    const instructionPreview = discovery.getEffectiveInstructions();
    const selectedInstructionIds = new Set(
      instructionPreview.contextGroups.flatMap((group) => group.selectedFileIds),
    );
    const ambiguousInstructionIds = new Set(
      instructionPreview.contextGroups
        .filter((group) => group.ambiguity)
        .flatMap((group) => group.candidates.map((candidate) => candidate.fileId)),
    );
    const nodes = [];
    const edges = [];
    const diagnostics = [];
    const pushResource = (resource) => {
      const id = nodeId(resource.kind, resource.id);
      nodes.push({
        id,
        resourceId: resource.id,
        kind: resource.kind,
        name: resource.name,
        scope: resource.scope,
        state: resource.state,
        sourcePath: resource.source?.displayPath || null,
        effectiveModel: resource.effectiveModel,
        capabilities: resource.capabilities || null,
        cost: resource.capabilities?.cost || null,
      });
      return id;
    };
    const agentNodes = new Map(agents.map((agent) => [agent.id, pushResource(agent)]));
    const skillNodes = new Map(skills.map((skill) => [skill.id, pushResource(skill)]));
    const modelNodes = new Map();
    const modelByRef = new Map();
    for (const model of models) {
      const id = pushResource(model);
      const ref = model.name;
      modelNodes.set(model.id, id);
      modelByRef.set(ref, {
        id,
        resource: model,
        cost: safeCost(model.capabilities?.cost),
        capabilities: model.capabilities || null,
      });
    }
    const runtimeModels = getRuntimeModels();
    for (const model of Array.isArray(runtimeModels) ? runtimeModels : []) {
      if (typeof model.ref !== 'string' || modelByRef.has(model.ref)) continue;
      const id = `runtime-model:${model.ref}`;
      const cost = safeCost(model.cost);
      modelByRef.set(model.ref, {
        id,
        resource: model,
        cost,
        capabilities: {
          reasoning: model.reasoning,
          input: model.input,
          contextTokens: model.contextWindow,
          outputTokens: model.maxTokens,
        },
      });
      nodes.push({
        id,
        kind: 'model',
        name: model.ref,
        scope: 'runtime-catalog',
        state: 'unknown',
        sourcePath: null,
        cost: cost || null,
        capabilities: {
          reasoning: model.reasoning,
          input: model.input,
          contextTokens: model.contextWindow,
          outputTokens: model.maxTokens,
        },
        catalogSource: 'installed-pi-runtime',
      });
    }
    const instructionNodes = new Map();
    for (const source of instructions) {
      const id = nodeId('instruction', source.id);
      instructionNodes.set(source.id, id);
      nodes.push({
        id,
        fileId: source.id,
        kind: 'instruction',
        name: source.displayPath.split(/[\\/]/).at(-1) || 'instruction',
        scope: source.scope,
        state: source.trust === 'untrusted' ? 'untrusted' : 'unknown',
        sourcePath: source.displayPath,
      });
    }
    const skillByName = new Map(skills.map((skill) => [skill.name.toLowerCase(), skill]));
    const agentByName = new Map();
    for (const agent of agents) {
      agentByName.set(agent.name.toLowerCase(), agent);
      if (agent.canonicalName) agentByName.set(String(agent.canonicalName).toLowerCase(), agent);
    }
    const referencedSkills = new Set();
    const inboundAgents = new Set();
    const addEdge = (from, to, type, status, explanation) =>
      edges.push({ from, to, type, status, explanation });
    const addDiag = (resource, code, message) =>
      diagnostics.push({
        code,
        severity: 'warning',
        resourceId: resource.id,
        name: resource.name,
        confidence: 'static-reference-check',
        message,
      });

    for (const agent of agents) {
      const from = agentNodes.get(agent.id);
      const modelValue = agent.effectiveModel?.value;
      const ref = modelReference(modelValue);
      if (ref && agent.effectiveModel?.certainty === 'static') {
        const model = modelByRef.get(ref);
        if (model)
          addEdge(from, model.id, 'model-selection', 'resolved', `Static adapter value: ${ref}.`);
        else {
          addEdge(
            from,
            `unresolved-model:${encodeURIComponent(ref)}`,
            'model-selection',
            'unresolved',
            `Configured reference ${ref} is absent from the safely inspected catalog.`,
          );
          addDiag(
            agent,
            'MODEL_REFERENCE_UNRESOLVED',
            `Model reference ${ref} is not in the inspected model catalog.`,
          );
        }
      } else {
        addEdge(
          from,
          'model-context:unknown',
          'model-selection',
          'unknown',
          'The model is inherited, provider-dependent, or not statically resolvable.',
        );
        if (modelValue && modelValue !== 'inherit')
          addDiag(
            agent,
            'MODEL_SELECTION_UNCERTAIN',
            'Effective model depends on runtime or provider-scoped state.',
          );
      }
      for (const skillName of list(field(agent, 'skills'))) {
        const skill =
          skillByName.get(skillName.toLowerCase()) ||
          skillByName.get(skillName.split('/').at(-1).toLowerCase());
        if (skill) {
          referencedSkills.add(skill.id);
          addEdge(
            from,
            skillNodes.get(skill.id),
            'skill-reference',
            'resolved',
            `Explicit adapter reference: ${skillName}.`,
          );
        } else {
          addEdge(
            from,
            `unresolved-skill:${encodeURIComponent(skillName)}`,
            'skill-reference',
            'unresolved',
            `Referenced skill ${skillName} was not found in the inventory.`,
          );
          addDiag(
            agent,
            'SKILL_REFERENCE_MISSING',
            `Referenced skill “${skillName}” was not found.`,
          );
        }
      }
      const allowed = field(agent, 'allowedAgents');
      for (const name of list(allowed)) {
        const target = agentByName.get(name.toLowerCase());
        if (target) {
          inboundAgents.add(target.id);
          addEdge(
            from,
            agentNodes.get(target.id),
            'agent-workflow',
            'resolved',
            `Adapter allowed-agent reference: ${name}.`,
          );
        } else {
          addEdge(
            from,
            `unresolved-agent:${encodeURIComponent(name)}`,
            'agent-workflow',
            'unresolved',
            `Allowed agent ${name} was not found in the known adapter inventory.`,
          );
          addDiag(agent, 'AGENT_REFERENCE_MISSING', `Allowed agent “${name}” was not found.`);
        }
      }
      for (const toolName of list(field(agent, 'tools'))) {
        if (toolName.toLowerCase() === 'inherit') continue;
        const id = `tool-reference:${encodeURIComponent(toolName)}`;
        if (!nodes.some((node) => node.id === id))
          nodes.push({
            id,
            kind: 'tool-reference',
            name: toolName,
            scope: 'runtime',
            state: 'unknown',
            sourcePath: null,
          });
        addEdge(
          from,
          id,
          'tool-selection',
          'declared',
          `Configured tool allowlist; actual registered tool availability is runtime-dependent.`,
        );
      }
      for (const toolName of list(field(agent, 'excludeTools'))) {
        const id = `tool-reference:${encodeURIComponent(toolName)}`;
        if (!nodes.some((node) => node.id === id))
          nodes.push({
            id,
            kind: 'tool-reference',
            name: toolName,
            scope: 'runtime',
            state: 'unknown',
            sourcePath: null,
          });
        addEdge(
          from,
          id,
          'tool-exclusion',
          'declared',
          'Configured exclusion; actual registered tool availability is runtime-dependent.',
        );
      }
      const projectPolicy = field(agent, 'inheritProjectContext');
      const globalPolicy = field(agent, 'inheritGlobalContext');
      for (const source of instructions) {
        const isGlobal = source.scope === 'global';
        const policy = isGlobal ? globalPolicy : projectPolicy;
        const fieldName = isGlobal ? 'inheritGlobalContext' : 'inheritProjectContext';
        const enabled = policy === true && (!isGlobal || projectPolicy === true);
        const disabled = policy === false || (isGlobal && projectPolicy === false);
        let status = disabled ? 'disabled' : 'unknown';
        let explanation = disabled
          ? `${fieldName} policy excludes this source.`
          : `${fieldName} is not statically established.`;
        if (!disabled && enabled) {
          if (agent.state === 'untrusted' && !isGlobal) {
            status = 'disabled';
            explanation = 'Project-scoped resources are untrusted in this workspace.';
          } else if (ambiguousInstructionIds.has(source.id)) {
            status = 'unknown';
            explanation =
              'Pi has ambiguous same-directory instruction candidates; none is selected in the static preview.';
          } else if (selectedInstructionIds.has(source.id)) {
            status = agent.adapterCompatibility === 'supported' ? 'policy-included' : 'conditional';
            explanation =
              agent.adapterCompatibility === 'supported'
                ? `${fieldName}=true and the source is selected by the static Pi context-file resolver; a child session was not executed.`
                : `${fieldName}=true, but the installed agent adapter version is not verified.`;
          } else {
            status = 'disabled';
            explanation = 'This candidate is not selected by the static Pi context-file resolver.';
          }
        }
        if (status === 'unknown') {
          const boundary = `context-policy:${agent.id}:${fieldName}`;
          if (!nodes.some((node) => node.id === boundary))
            nodes.push({
              id: boundary,
              kind: 'context-policy',
              name: fieldName,
              scope: 'unknown',
              state: 'unknown',
              sourcePath: null,
            });
          addEdge(from, boundary, 'context-policy', status, explanation);
        } else {
          addEdge(from, instructionNodes.get(source.id), 'context-policy', status, explanation);
        }
      }
      const promptMode = field(agent, 'systemPromptMode');
      const promptNode = `prompt-policy:${agent.id}`;
      nodes.push({
        id: promptNode,
        kind: 'prompt-policy',
        name: promptMode || 'systemPromptMode unknown',
        scope: 'adapter-policy',
        state: promptMode ? 'known' : 'unknown',
        sourcePath: null,
      });
      addEdge(
        from,
        promptNode,
        'system-prompt-policy',
        promptMode === 'append'
          ? 'base-prompt-retained'
          : promptMode === 'replace'
            ? 'base-prompt-replaced'
            : 'unknown',
        promptMode === 'append'
          ? 'Adapter config appends agent instructions to Pi base prompt.'
          : promptMode === 'replace'
            ? 'Adapter config replaces the Pi base prompt with agent instructions.'
            : 'System prompt mode is not statically explicit; adapter defaults may apply.',
      );
      const skillPolicy = field(agent, 'inheritSkills');
      if (skillPolicy === true) {
        for (const skill of skills) {
          referencedSkills.add(skill.id);
          addEdge(
            from,
            skillNodes.get(skill.id),
            'skill-inheritance',
            agent.adapterCompatibility === 'supported' ? 'conditional' : 'unknown',
            'Adapter policy permits the discovered skills catalog; session-specific skill availability is not executed here.',
          );
        }
      }
      const model = modelValue === 'inherit' || !ref ? null : modelByRef.get(ref);
      if (model && !model.cost)
        addDiag(
          agent,
          'MODEL_COST_UNKNOWN',
          `No verified input/output rate is available for ${ref}; no estimate will be produced.`,
        );
    }
    for (const skill of skills)
      if (!referencedSkills.has(skill.id))
        addDiag(
          skill,
          'ORPHAN_SKILL',
          'No configured agent explicitly references this skill, and no agent has a known skill-inheritance policy. Interactive use or runtime extension registration may still make it reachable.',
        );
    for (const agent of agents)
      if (!inboundAgents.has(agent.id))
        addDiag(
          agent,
          'UNREFERENCED_AGENT',
          'No known agent workflow references this agent; top-level tool, command, or prompt routing may still use it.',
        );
    return {
      piVersion: environment.piVersion || 'unknown',
      certainty: 'static-policy-only',
      limitations: [
        'The graph describes adapter-declared references and inheritance policy, not an executed agent workflow or exact child-session prompt.',
        'Unknown, inherited, provider-scoped, and runtime-added behavior is represented as unresolved or conditional.',
        'Cost estimates require an explicit token scenario and complete verified input/output rates; they are not billing or quota predictions.',
      ],
      nodes,
      edges,
      diagnostics,
      models: [...modelByRef.entries()].map(([ref, model]) => ({
        ref,
        cost: model.cost,
        capabilities: model.capabilities,
        source:
          model.resource.catalogOrigin ||
          (model.resource.source === 'installed-pi-runtime'
            ? 'installed-pi-runtime'
            : 'configured'),
      })),
      agents: agents.map((agent) => ({
        id: agent.id,
        nodeId: agentNodes.get(agent.id),
        name: agent.name,
        effectiveModel: agent.effectiveModel || null,
      })),
      instructionSourceCount: instructions.length,
    };
  }

  return {
    graph: buildGraph,
    async estimate(payload) {
      const parsed = estimateSchema.safeParse(payload);
      if (!parsed.success)
        throw Object.assign(
          new Error(parsed.error.issues.map((issue) => issue.message).join(' ')),
          { code: 'INVALID_INPUT', status: 400 },
        );
      const graph = await buildGraph();
      const agentsById = new Map(graph.agents.map((agent) => [agent.id, agent]));
      const modelsByRef = new Map(graph.models.map((model) => [model.ref, model]));
      const invocations = parsed.data.invocations.length
        ? parsed.data.invocations
        : graph.agents.map((agent) => ({ agentId: agent.id, count: 1 }));
      const estimates = [];
      let knownSubtotal = 0;
      const unknown =
        graph.agents.length === 0
          ? [
              {
                agentId: null,
                name: 'No agents',
                reason: 'No supported static agent workflow is available to estimate.',
              },
            ]
          : [];
      for (const invocation of invocations) {
        if (invocation.count === 0) continue;
        const agent = agentsById.get(invocation.agentId);
        if (!agent)
          throw Object.assign(new Error('Scenario contains an unknown agent.'), {
            code: 'INVALID_AGENT',
            status: 422,
          });
        const edge = graph.edges.find(
          (candidate) => candidate.from === agent.nodeId && candidate.type === 'model-selection',
        );
        const model =
          edge?.status === 'resolved'
            ? modelsByRef.get(graph.nodes.find((node) => node.id === edge.to)?.name)
            : null;
        if (!model?.cost) {
          unknown.push({
            agentId: agent.id,
            name: agent.name,
            reason: edge?.explanation || 'No fixed model/cost rate is available.',
          });
          continue;
        }
        const perCall =
          (parsed.data.inputTokensPerCall * model.cost.input) / 1_000_000 +
          (parsed.data.outputTokensPerCall * model.cost.output) / 1_000_000;
        const total = perCall * invocation.count;
        knownSubtotal += total;
        estimates.push({
          agentId: agent.id,
          name: agent.name,
          model: edge.explanation,
          invocationCount: invocation.count,
          perCallUsd: perCall,
          totalUsd: total,
          ratesUsdPerMillion: model.cost,
        });
      }
      return {
        currency: 'USD',
        tokenAssumptions: {
          inputTokensPerCall: parsed.data.inputTokensPerCall,
          outputTokensPerCall: parsed.data.outputTokensPerCall,
        },
        knownSubtotalUsd: knownSubtotal,
        totalUsd: unknown.length ? null : knownSubtotal,
        complete: unknown.length === 0,
        estimates,
        unknown,
        caveat:
          'Illustrative only: does not include tool calls, retries, caching, provider-side tokenization, context growth, or actual runtime model selection.',
      };
    },
  };
}
