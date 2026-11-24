import type { CommandResult, CreateTaskRequest } from "@fm1/agent-core";
import type { ChatRunSettingsValue, NormalizedAgent } from "../normalize";
import { taskCreateArgv, type TaskCreateOutcome } from "./cli";
import type { ProviderModel } from "./config";
import { projectTarget } from "./mapping";

/**
 * Pure builders for createTask (`traycer task create`) and createSession
 * (`epic.createChat`). The provider's harness + model come from config; the
 * permission mode defaults to `supervised` so tool calls surface as approvals.
 */
export function createTaskArgv(request: CreateTaskRequest, model: ProviderModel): string[] {
  return taskCreateArgv({
    message: request.prompt?.trim() || request.title,
    harnessId: model.harnessId,
    model: model.model,
    title: request.title,
    ...projectTarget(request.project.projectId),
    ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
    permissionMode: model.permissionMode ?? "supervised",
    // Namespaced so a console requestId can never collide with another tool's key.
    idempotencyKey: `fm1-${request.requestId}`,
  });
}

/** CLI failure -> CommandResult. An outcome-unknown failure is `sent`: it may exist, so never retried. */
export function taskCreateFailure(requestId: string, outcome: Extract<TaskCreateOutcome, { ok: false }>): CommandResult {
  return { requestId, stage: outcome.mayHaveCreated ? "sent" : "failed", message: `${outcome.code}: ${outcome.message}` };
}

export function chatSettingsFor(model: ProviderModel): ChatRunSettingsValue {
  return {
    harnessId: model.harnessId,
    model: model.model,
    permissionMode: model.permissionMode ?? "supervised",
    reasoningEffort: model.reasoningEffort ?? null,
    serviceTier: null,
    agentMode: "regular",
    profileId: null,
    ultracode: false,
  } as unknown as ChatRunSettingsValue;
}

export function newChatAgent(
  args: { readonly epicId: string; readonly chatId: string; readonly hostId: string; readonly userId: string; readonly now: number },
  model: ProviderModel,
): NormalizedAgent {
  return {
    epicId: args.epicId,
    agentId: args.chatId,
    surface: "gui",
    harnessId: model.harnessId,
    model: model.model,
    reasoningEffort: model.reasoningEffort ?? null,
    permissionMode: model.permissionMode ?? "supervised",
    profileId: null,
    title: "",
    parentId: null,
    hostId: args.hostId,
    ownerUserId: args.userId,
    archived: false,
    sessionState: null,
    createdAt: args.now,
    updatedAt: args.now,
  };
}
