import dns from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { EgressPolicyError } from './errors.js';
import { canonicalizeUrl } from './url-policy.js';

export function classifyAddress(address) {
  let parsed;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    throw new EgressPolicyError('DNS returned an invalid IP address');
  }
  if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) parsed = parsed.toIPv4Address();
  return { kind: parsed.kind(), range: parsed.range(), normalized: parsed.toString() };
}

export class EgressPolicy {
  constructor({ resolver = dns.lookup, allowedOrigins = [] } = {}) {
    this.resolver = resolver;
    this.allowedOrigins = new Set(allowedOrigins.map((origin) => new URL(origin).origin));
  }

  async resolve(urlValue) {
    const url = new URL(canonicalizeUrl(urlValue));
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let answers;
    try {
      answers = await this.resolver(hostname, { all: true, verbatim: true });
    } catch (error) {
      throw new EgressPolicyError(`DNS resolution failed: ${error.code ?? 'unknown'}`);
    }
    if (!Array.isArray(answers) || answers.length === 0) throw new EgressPolicyError('DNS returned no addresses');

    const classifications = answers.map((answer) => ({
      ...answer,
      classification: classifyAddress(answer.address),
    }));
    if (!this.allowedOrigins.has(url.origin)) {
      const unsafe = classifications.find((answer) => answer.classification.range !== 'unicast');
      if (unsafe) throw new EgressPolicyError(`destination address range is not public unicast: ${unsafe.classification.range}`);
    }

    const selected = classifications[0];
    return {
      address: selected.classification.normalized,
      family: selected.family ?? (selected.classification.kind === 'ipv4' ? 4 : 6),
      origin: url.origin,
    };
  }
}
