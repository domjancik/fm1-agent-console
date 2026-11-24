// Decides which COMMAND_RESULT a handled device input deserves (protocol: the device assumes nothing
// succeeded until COMMAND_RESULT arrives). Wording: docs/ux-v2.md section 1.5 (agent-core copy.ts).
import { DEFAULT_BACKEND, toastFor, type CommandResult, type ControllerAction, type ControllerState, type RecordedResult, type VoiceState } from "@fm1/agent-core";

export interface Feedback {
  stage: CommandResult["stage"];
  text: string;
}

/**
 * Results recorded by the console (focus, interrupt, approvals, rejections) become toasts via `toastFor`.
 * Otherwise only a notice the controller decided on (knob value, pin, sort, dismiss, cancel, refusals) is shown.
 * Select, mark-read, view switches, an opened confirm and voice start/stop get no toast: the screen already changes.
 * voiceSubmit is reported by the StageRelay instead.
 */
export function feedbackFor(
  actions: readonly ControllerAction[],
  results: readonly (CommandResult | RecordedResult)[],
  _before: { state: ControllerState; voice: VoiceState },
  after: { state: ControllerState; voice: VoiceState },
  /** The backend's name for `<name> offline` (the adapter's, agent-core `backendName`). */
  backend: string = DEFAULT_BACKEND,
): Feedback[] {
  if (results.length > 0) return results.map((r) => ({ stage: r.stage, text: toastFor(r.stage, r.message, "action" in r ? r.action : undefined, backend) }));
  if (actions.some((a) => a.type === "voiceSubmit")) return [];
  const n = after.state.notice;
  return n ? [{ stage: n.stage, text: n.text }] : [];
}
