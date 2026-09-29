import type { AssistantMessage } from '@earendil-works/pi-ai';
import { isRetryableAssistantError } from '@earendil-works/pi-ai';

// These responses require account or human action. Repeating the request can
// prolong a provider block, even when its HTTP status is otherwise retryable.
const RISK_CONTROL_PATTERN =
  /risk.?control|风控|captcha|security (?:check|challenge|verification)|verify (?:you are human|your identity)|suspicious activity|unusual activity|account (?:blocked|restricted|suspended)|access denied|web application firewall|\bWAF\b|cloudflare challenge/i;

const NON_TRANSIENT_FAILURE_PATTERN =
  /\b(?:400|401|402|403|404|422)\b|invalid[_ ]api[_ ]key|insufficient[_ ]quota|quota exceeded|payment required/i;

// Pi's classifier covers common fetch failures but misses several socket and
// TLS errors reported by Node, proxies, and custom OpenAI endpoints.
const ADDITIONAL_CONNECTION_PATTERN =
  /ECONNRESET|ECONNABORTED|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|ERR_NETWORK|ERR_STREAM_PREMATURE_CLOSE|connection (?:reset|closed|dropped|failed|interrupted|aborted|timed out)|socket (?:closed|disconnected|reset|error)|TLS handshake (?:failed|error)|network (?:disconnected|unreachable)|连接(?:失败|断开|重置)|网络(?:错误|中断)/i;

// HTTP 520 is a transient response from a gateway/proxy, omitted by pi-ai's
// retry classifier. Keep the match tied to an HTTP status to avoid retrying
// unrelated messages that happen to contain the number 520.
const HTTP_520_PATTERN =
  /\b(?:520\s+status\s+code|(?:HTTP(?:\/\d(?:\.\d)?)?|status(?:\s+code)?)\s*[:=]?\s*520)\b/i;
const HTTP_520_MAX_RETRIES = 3;

export function isHttp520Error(errorMessage: string): boolean {
  return HTTP_520_PATTERN.test(errorMessage);
}

export function isCraftRetryableAssistantError(message: AssistantMessage): boolean {
  if (message.stopReason !== 'error' || !message.errorMessage) return false;
  if (RISK_CONTROL_PATTERN.test(message.errorMessage) || NON_TRANSIENT_FAILURE_PATTERN.test(message.errorMessage)) return false;
  return isRetryableAssistantError(message) ||
    ADDITIONAL_CONNECTION_PATTERN.test(message.errorMessage) ||
    isHttp520Error(message.errorMessage);
}

/** Use the same classifier for Pi's retry decision and Craft's error display. */
export function installCraftPiRetryClassifier(session: object): void {
  const sdkSession = session as {
    _isRetryableError?: (message: AssistantMessage) => boolean;
    _retryAttempt?: number;
  };
  const sdkClassifier = sdkSession._isRetryableError;
  if (typeof sdkClassifier !== 'function') {
    throw new Error('Pi SDK retry classifier is unavailable');
  }
  sdkSession._isRetryableError = (message) => {
    if (!isCraftRetryableAssistantError(message)) return false;
    const errorMessage = message.errorMessage ?? '';
    // The SDK uses this counter for both agent_end.willRetry and _prepareRetry.
    // Check it here so the third failed reconnect ends normally with the 520.
    if (isHttp520Error(errorMessage) && (sdkSession._retryAttempt ?? 0) >= HTTP_520_MAX_RETRIES) {
      return false;
    }
    return sdkClassifier.call(sdkSession, message) ||
      ADDITIONAL_CONNECTION_PATTERN.test(errorMessage) ||
      isHttp520Error(errorMessage);
  };
}
