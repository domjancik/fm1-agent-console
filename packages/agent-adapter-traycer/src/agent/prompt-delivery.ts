import { randomUUID } from "node:crypto";
import type { CommandResult, DeliveryStage } from "@fm1/agent-core";
import { plainTextPromptContent } from "@traycer-clients/shared/epic/plain-text-content";
import type { ChatRunSettingsValue } from "../normalize";
import { PromptTracker } from "../prompt-tracker";
import type { ChatClientFrame, ChatFrame } from "../streams";
import type { ChatChannel } from "./chat-channel";

/**
 * Delivers one user prompt to a GUI chat over `chat.subscribe` `send` and
 * reports the stages agent-core expects:
 *
 *   accepted_locally   (validated, about to send)
 *   sent               (`actionAck{status:accepted}` for our clientActionId)
 *   backend_acknowledged (`messageAccepted` carrying our messageId, or our message in a `queueChanged` queue while a
 *                      turn runs: message QUEUED_MESSAGE) -> the call resolves here
 *   completed          (the turn whose `userMessageId` is ours reached `completed`), as a
 *                      later `command_progress` event; a stopped/errored turn reports `failed`.
 *
 * The frame is written at most once. If no ack arrives the result is `sent`
 * (uncertain, never retried), not `failed`.
 */
export interface DeliveryArgs {
  readonly requestId: string;
  readonly epicId: string;
  readonly chatId: string;
  readonly text: string;
  readonly userId: string;
  readonly hostId: string;
  readonly settings: ChatRunSettingsValue;
  readonly ackTimeoutMs: number;
  readonly turnTimeoutMs: number;
}

/** The `backend_acknowledged` message of a prompt the host queued behind a running turn (agent-core toastFor). */
export const QUEUED_MESSAGE = "queued behind the running turn";

export type ProgressSink = (requestId: string, stage: DeliveryStage, message?: string) => void;

const STALE_TARGET = /not[_ ]?found|unknown[_ ]?chat|deleted|archived|no such|gone/i;

export function deliverPrompt(channel: ChatChannel, release: () => void, args: DeliveryArgs, progress: ProgressSink): Promise<CommandResult> {
  const clientActionId = randomUUID();
  const messageId = randomUUID();
  const tracker = new PromptTracker(clientActionId, messageId, channel.activeTurn?.turnId ?? null);
  const { requestId } = args;

  if (channel.closed) {
    // Closed between waitReady and now: sendAction would drop the frame silently, so nothing went out.
    release();
    return Promise.resolve({ requestId, stage: "failed", message: `chat stream closed before the send; nothing sent (${channel.closeError().message})` });
  }
  return new Promise<CommandResult>((resolve) => {
    let resolved = false;
    let sentStage = false;
    let acked = false;
    let done = false;
    const settle = (result: CommandResult): void => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(ackTimer);
      clearTimeout(turnTimer);
      stopFrames();
      stopClose();
      release();
    };

    const ackTimer = setTimeout(() => {
      const message = sentStage
        ? `host accepted the send but did not confirm the message within ${args.ackTimeoutMs}ms; not resent`
        : `no host ack within ${args.ackTimeoutMs}ms; delivery uncertain, not resent`;
      settle({ requestId, stage: "sent", message });
    }, args.ackTimeoutMs);
    const turnTimer = setTimeout(finish, args.turnTimeoutMs);

    const onFrame = (frame: ChatFrame): void => {
      const settledNow = tracker.consume(frame);
      if (tracker.ack?.status === "accepted" && !sentStage) {
        sentStage = true;
        progress(requestId, "sent");
      }
      if (tracker.messageAccepted && !acked) {
        acked = true;
        clearTimeout(ackTimer);
        progress(requestId, "backend_acknowledged");
        settle({ requestId, stage: "backend_acknowledged" });
      }
      if (tracker.queued && !acked) {
        // Durable in the chat's queue: it runs when the current turn ends. Not a failure, and never resent.
        acked = true;
        clearTimeout(ackTimer);
        progress(requestId, "backend_acknowledged", QUEUED_MESSAGE);
        settle({ requestId, stage: "backend_acknowledged", message: QUEUED_MESSAGE });
      }
      if (!settledNow) return;
      const outcome = tracker.result;
      if (outcome.kind === "rejected") {
        const why = [outcome.ack.code, outcome.ack.reason].filter(Boolean).join(": ") || "rejected by host";
        const stage: DeliveryStage = STALE_TARGET.test(why) ? "target_unavailable" : "failed";
        progress(requestId, stage, why);
        settle({ requestId, stage, message: why });
      } else if (outcome.kind === "finished") {
        if (!acked) {
          acked = true;
          settle({ requestId, stage: "backend_acknowledged" });
        }
        if (outcome.status === "completed") progress(requestId, "completed");
        else progress(requestId, "failed", `turn ${outcome.status}`);
      }
      finish();
    };

    const stopFrames = channel.onFrame(onFrame);
    const stopClose = channel.onClose(() => {
      // The frame was already written: the host may have it. Never report a retryable `failed` here,
      // or a retry with the same requestId would send the prompt twice.
      const message = `chat stream closed after the send (${channel.closeError().message}); delivery uncertain, not resent`;
      settle({ requestId, stage: "sent", message });
      finish();
    });

    const frame: ChatClientFrame = {
      kind: "send",
      hasBinaryPayload: false,
      epicId: args.epicId,
      chatId: args.chatId,
      clientActionId,
      messageId,
      content: plainTextPromptContent(args.text),
      sender: { type: "user", userId: args.userId },
      settings: args.settings,
      accountContext: { type: "PERSONAL" },
      sentFromHostId: args.hostId,
      deliveryPolicy: "auto",
      worktreeIntent: null,
      browserAnnotations: [],
    } as ChatClientFrame;
    channel.send(frame);
  });
}
