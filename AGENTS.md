# Repository instructions

- Never fetch a page before the applicable robots policy and egress decision are known.
- One origin can hold at most one active frontier lease. Completion or expired-lease recovery must release exactly that token.
- Revalidate every redirect hop and pin the approved DNS answer into the socket lookup.
- A content digest deduplicates stored bytes only; URL identity, fetch receipt, status, and recrawl metadata remain distinct.
- Do not log raw URLs, query strings, HTML, IPs, lease tokens, validators, or content digests.
- Local SQLite, loopback fixtures, and green CI do not prove distributed frontier coordination, internet politeness, production capacity, or legal permission to crawl.
