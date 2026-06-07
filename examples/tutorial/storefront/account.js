// The account record the storefront API serves.
//
// THE BUG (intentional — this is the whole tutorial; see README.md and the
// guard in test/tutorial-storefront.test.ts): the stored account is in EUR, but
// `GET /account` SILENTLY DROPS the `currency` field on the way to the wire. The
// OpenAPI contract (openapi.json) marks `currency` REQUIRED, so the response is
// in breach — yet nothing throws. A forgiving client (the dashboard, the USD
// ledger in server.js) defaults the missing field to USD, so the page still
// renders "$100.00" and the login flow passes, while the ledger silently
// under-reports every European balance. The breach is invisible until a
// contract-aware tool checks the response against the spec.
//
// The fix is one field: include `currency` in the returned response again.
const RECORD = { id: 'acct-42', owner: 'Ada Lovelace', balance: 10000, currency: 'EUR' }

export function getAccount() {
  // BUG: the required field (see header) is omitted from the wire response.
  return { id: RECORD.id, owner: RECORD.owner, balance: RECORD.balance }
}
