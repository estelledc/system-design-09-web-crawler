export class CrawlerError extends Error {
  constructor(message, { code = 'crawler_error', retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.code = code;
    this.retryable = retryable;
  }
}

export class UrlPolicyError extends CrawlerError {
  constructor(message) {
    super(message, { code: 'url_policy_rejected' });
  }
}

export class EgressPolicyError extends CrawlerError {
  constructor(message) {
    super(message, { code: 'egress_policy_rejected' });
  }
}

export class FetchTimeoutError extends CrawlerError {
  constructor() {
    super('HTTP request timed out', { code: 'fetch_timeout', retryable: true });
  }
}

export class BodyLimitError extends CrawlerError {
  constructor(limit) {
    super(`response exceeded ${limit} bytes`, { code: 'body_limit_exceeded' });
  }
}

export class RedirectPolicyError extends CrawlerError {
  constructor(message) {
    super(message, { code: 'redirect_policy_rejected' });
  }
}

export class LeaseError extends CrawlerError {
  constructor(message) {
    super(message, { code: 'lease_conflict' });
  }
}
