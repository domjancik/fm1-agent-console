import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import { openRawStream, watchAgentActivity, type ConnectionEvent, type RawStream } from "../streams";
import { Backoff, type BackoffPolicy } from "./backoff";
import {
  isActivityByEpic,
  parseChatRecordFrame,
  parseNotificationFrame,
  type NotificationEvent,
  type RecordEvent,
} from "./feeds";

export type FeedName = "agent.activity.subscribe" | "host.chatRecords.subscribe" | "host.notifications.subscribe";
export type FeedStatus = "connecting" | "open" | "reconnecting" | "dead" | "stopped";

export interface FeedHandlers {
  onActivity(byEpic: Record<string, { working: string[]; turn: string[] }>, servedBy: string): void;
  onRecord(event: Exclude<RecordEvent, { kind: "ignored" | "malformed" }>): void;
  onNotification(event: Exclude<NotificationEvent, { kind: "ignored" | "malformed" }>): void;
  onMalformed(feed: FeedName, why: string): void;
  /** A feed lost its socket (host gone or restarting). */
  onDrop(feed: FeedName, reason: string): void;
  /** A feed (re)opened. */
  onOpen(feed: FeedName): void;
  /** The host can never serve this feed (fatal close, e.g. INCOMPATIBLE). */
  onDead(feed: FeedName, code: string, reason: string): void;
}

/** The three host-wide event feeds over the shared stream client. */
export class LiveFeeds {
  readonly status: Record<FeedName, FeedStatus> = {
    "agent.activity.subscribe": "stopped",
    "host.chatRecords.subscribe": "stopped",
    "host.notifications.subscribe": "stopped",
  };
  private closers: Array<() => void> = [];

  constructor(private readonly handlers: FeedHandlers) {}

  start(client: WsStreamClient<HostStreamRpcRegistry>): void {
    if (this.closers.length > 0) return;
    const activity = watchAgentActivity(
      client,
      (byEpic, servedBy) => {
        if (isActivityByEpic(byEpic)) this.handlers.onActivity(byEpic, servedBy);
        else this.handlers.onMalformed("agent.activity.subscribe", "state frame shape");
      },
      (event) => this.connection("agent.activity.subscribe", event),
    );
    this.closers.push(() => activity.close());
    const records: RawStream = openRawStream(
      client,
      "host.chatRecords.subscribe",
      {},
      (frame) => {
        const event = parseChatRecordFrame(frame);
        if (event.kind === "malformed") this.handlers.onMalformed("host.chatRecords.subscribe", event.why);
        else if (event.kind !== "ignored") this.handlers.onRecord(event);
      },
      (event) => this.connection("host.chatRecords.subscribe", event),
    );
    this.closers.push(() => records.close());
    const notifications: RawStream = openRawStream(
      client,
      "host.notifications.subscribe",
      { filter: "all", initialLimit: 200 },
      (frame) => {
        const event = parseNotificationFrame(frame);
        if (event.kind === "malformed") this.handlers.onMalformed("host.notifications.subscribe", event.why);
        else if (event.kind !== "ignored") this.handlers.onNotification(event);
      },
      (event) => this.connection("host.notifications.subscribe", event),
    );
    this.closers.push(() => notifications.close());
    for (const name of Object.keys(this.status) as FeedName[]) this.status[name] = "connecting";
  }

  stop(): void {
    const closers = this.closers;
    this.closers = [];
    for (const name of Object.keys(this.status) as FeedName[]) this.status[name] = "stopped";
    for (const close of closers) close();
  }

  get running(): boolean {
    return this.closers.length > 0;
  }

  dead(feed: FeedName): boolean {
    return this.status[feed] === "dead";
  }

  private connection(feed: FeedName, event: ConnectionEvent): void {
    if (this.status[feed] === "stopped" || this.status[feed] === "dead") return;
    if (event.status === "open") {
      this.status[feed] = "open";
      this.handlers.onOpen(feed);
    } else if (event.status === "reconnecting") {
      const was = this.status[feed];
      this.status[feed] = "reconnecting";
      if (was !== "reconnecting") this.handlers.onDrop(feed, event.retryCause?.code ?? "stream reconnecting");
    } else if (event.status === "closed" && event.reason?.kind === "fatalError") {
      this.status[feed] = "dead";
      this.handlers.onDead(feed, event.reason.details.code, event.reason.details.reason);
    }
  }
}

/**
 * Fallback polling, used only while an event feed is dead. The interval grows
 * by the backoff policy while polls find nothing new, and resets on a change.
 */
export class FallbackPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly backoff: Backoff;
  private active = false;
  polls = 0;

  constructor(
    policy: BackoffPolicy,
    private readonly poll: () => Promise<boolean>,
  ) {
    this.backoff = new Backoff(policy);
  }

  get running(): boolean {
    return this.active;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.schedule();
  }

  stop(): void {
    this.active = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.backoff.reset();
  }

  private schedule(): void {
    if (!this.active) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      this.polls += 1;
      let changed = false;
      try {
        changed = await this.poll();
      } catch {
        changed = false;
      }
      if (changed) this.backoff.reset();
      this.schedule();
    }, this.backoff.next());
  }
}
