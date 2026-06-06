// The account record the storefront API serves.
//
// THE BUG (intentional — this is the whole tutorial; see README.md and the
// guard in test/tutorial-storefront.test.ts): `balance` is the STRING '10000',
// but the OpenAPI contract (openapi.json) declares it an INTEGER (cents). The
// dashboard coerces it on the way to the screen (`'10000' / 100 === 100`), so
// the UI renders "$100.00" and the browser flow passes — yet the API is quietly
// violating its own contract. A consumer in another language, or a stricter
// client, would break.
//
// The fix is one character class: change the string '10000' to the number 10000.
export function getAccount() {
  return {
    id: 'acct-42',
    owner: 'Ada Lovelace',
    balance: '10000',
    currency: 'USD',
  }
}
