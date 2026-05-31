// @usebruno/lang ships JavaScript without type declarations. The api package
// declares this module for its own build, but that ambient .d.ts is not in
// scope when this package typechecks @strummer/api's source via project
// references. Re-declare the V2 surface so cross-package types resolve.
declare module '@usebruno/lang' {
  export function bruToJsonV2(content: string): unknown
  export function jsonToBruV2(json: unknown): string
  export function bruToEnvJsonV2(content: string): unknown
  export function envJsonToBruV2(json: unknown): string
  export function collectionBruToJson(content: string): unknown
  export function jsonToCollectionBru(json: unknown): string
}
