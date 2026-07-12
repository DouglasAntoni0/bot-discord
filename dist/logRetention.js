"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LogRetentionManager = void 0;
exports.partitionOwnedMessages = partitionOwnedMessages;
exports.walkMessageHistory = walkMessageHistory;
const DEFAULT_RETRY_DELAY_MS = 60_000;
const DEFAULT_MAX_TIMER_DELAY_MS = 2_147_483_647;
class LogRetentionManager {
    timers = new Map();
    retentionMs;
    retryDelayMs;
    maxTimerDelayMs;
    now;
    setTimer;
    clearTimer;
    markAutomaticDelete;
    unmarkAutomaticDelete;
    isMissingMessageError;
    onDeleteError;
    constructor(options) {
        this.retentionMs = options.retentionMs;
        this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
        this.maxTimerDelayMs = options.maxTimerDelayMs ?? DEFAULT_MAX_TIMER_DELAY_MS;
        this.now = options.now ?? Date.now;
        this.setTimer =
            options.setTimer ??
                ((callback, delayMs) => setTimeout(callback, delayMs));
        this.clearTimer =
            options.clearTimer ??
                ((timer) => clearTimeout(timer));
        this.markAutomaticDelete = options.markAutomaticDelete ?? (() => undefined);
        this.unmarkAutomaticDelete = options.unmarkAutomaticDelete ?? (() => undefined);
        this.isMissingMessageError = options.isMissingMessageError ?? (() => false);
        this.onDeleteError = options.onDeleteError ?? (() => undefined);
    }
    schedule(message) {
        const remainingMs = this.getExpirationTimestamp(message) - this.now();
        if (remainingMs <= 0) {
            void this.deleteNow(message);
            return;
        }
        this.armExpirationTimer(message, remainingMs);
    }
    async deleteNow(message) {
        this.cancel(message.id);
        this.markAutomaticDelete(message.id);
        try {
            await message.delete();
            return true;
        }
        catch (error) {
            this.unmarkAutomaticDelete(message.id);
            if (this.isMissingMessageError(error)) {
                return true;
            }
            this.onDeleteError(message.id, error);
            this.armRetryTimer(message);
            return false;
        }
    }
    cancel(messageId) {
        const timer = this.timers.get(messageId);
        if (!timer)
            return;
        this.clearTimer(timer);
        this.timers.delete(messageId);
    }
    isScheduled(messageId) {
        return this.timers.has(messageId);
    }
    getExpirationTimestamp(message) {
        return message.createdTimestamp + this.retentionMs;
    }
    armExpirationTimer(message, remainingMs) {
        const delayMs = Math.min(Math.max(0, remainingMs), this.maxTimerDelayMs);
        this.armTimer(message, delayMs, () => {
            const nextRemainingMs = this.getExpirationTimestamp(message) - this.now();
            if (nextRemainingMs > 0) {
                this.armExpirationTimer(message, nextRemainingMs);
                return;
            }
            void this.deleteNow(message);
        });
    }
    armRetryTimer(message) {
        this.armTimer(message, this.retryDelayMs, () => {
            void this.deleteNow(message);
        });
    }
    armTimer(message, delayMs, callback) {
        this.cancel(message.id);
        const timer = this.setTimer(() => {
            this.timers.delete(message.id);
            callback();
        }, delayMs);
        timer.unref?.();
        this.timers.set(message.id, timer);
    }
}
exports.LogRetentionManager = LogRetentionManager;
function partitionOwnedMessages(messages, botUserId, now, retentionMs) {
    const owned = messages.filter((message) => message.author.id === botUserId);
    return {
        active: owned.filter((message) => now - message.createdTimestamp < retentionMs),
        expired: owned.filter((message) => now - message.createdTimestamp >= retentionMs),
    };
}
async function walkMessageHistory(options) {
    const pageSize = options.pageSize ?? 100;
    let before;
    while (true) {
        const messages = await options.fetchPage(before);
        if (messages.length === 0)
            return;
        await options.handlePage(messages);
        if (messages.length < pageSize)
            return;
        before = messages[messages.length - 1]?.id;
        if (!before)
            return;
    }
}
//# sourceMappingURL=logRetention.js.map