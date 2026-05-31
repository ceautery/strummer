// @usebruno/lang ships JavaScript without type declarations. Declare the V2
// surface we use; parsed output is `unknown` and narrowed at the call site.
declare module '@usebruno/lang' {
  export function bruToJsonV2(content: string): unknown
  export function jsonToBruV2(json: unknown): string
  export function bruToEnvJsonV2(content: string): unknown
  export function envJsonToBruV2(json: unknown): string
  export function collectionBruToJson(content: string): unknown
  export function jsonToCollectionBru(json: unknown): string
}
