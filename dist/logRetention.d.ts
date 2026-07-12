export interface RetentionMessage {
    id: string;
    createdTimestamp: number;
    delete(): Promise<unknown>;
}
interface TimerHandle {
    unref?: () => unknown;
}
export interface LogRetentionManagerOptions {
    retentionMs: number;
    retryDelayMs?: number;
    maxTimerDelayMs?: number;
    now?: () => number;
    setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
    clearTimer?: (timer: TimerHandle) => void;
    markAutomaticDelete?: (messageId: string) => void;
    unmarkAutomaticDelete?: (messageId: string) => void;
    isMissingMessageError?: (error: unknown) => boolean;
    onDeleteError?: (messageId: string, error: unknown) => void;
}
export declare class LogRetentionManager {
    private readonly timers;
    private readonly retentionMs;
    private readonly retryDelayMs;
    private readonly maxTimerDelayMs;
    private readonly now;
    private readonly setTimer;
    private readonly clearTimer;
    private readonly markAutomaticDelete;
    private readonly unmarkAutomaticDelete;
    private readonly isMissingMessageError;
    private readonly onDeleteError;
    constructor(options: LogRetentionManagerOptions);
    schedule(message: RetentionMessage): void;
    deleteNow(message: RetentionMessage): Promise<boolean>;
    cancel(messageId: string): void;
    isScheduled(messageId: string): boolean;
    private getExpirationTimestamp;
    private armExpirationTimer;
    private armRetryTimer;
    private armTimer;
}
export interface HistoryMessage {
    id: string;
}
export interface AuthoredHistoryMessage extends HistoryMessage {
    createdTimestamp: number;
    author: {
        id: string;
    };
}
export declare function partitionOwnedMessages<T extends AuthoredHistoryMessage>(messages: T[], botUserId: string, now: number, retentionMs: number): {
    active: T[];
    expired: T[];
};
export interface WalkHistoryOptions<T extends HistoryMessage> {
    fetchPage: (before?: string) => Promise<T[]>;
    handlePage: (messages: T[]) => Promise<void>;
    pageSize?: number;
}
export declare function walkMessageHistory<T extends HistoryMessage>(options: WalkHistoryOptions<T>): Promise<void>;
export {};
//# sourceMappingURL=logRetention.d.ts.map