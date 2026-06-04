// `@strummer/verify` type-imports `@strummer/api`'s result interfaces, which pulls
// api's source graph (it references `@usebruno/lang`, a JS dep with no type
// declarations) into this package's compilation. Mirror the ambient shim every
// other api consumer ships so tsc can resolve the module. (Erased at build; this
// package never imports `@usebruno/lang` at runtime.)
declare module '@usebruno/lang' {
  export function bruToJsonV2(content: string): unknown
  export function jsonToBruV2(json: unknown): string
  export function bruToEnvJsonV2(content: string): unknown
  export function envJsonToBruV2(json: unknown): string
  export function collectionBruToJson(content: string): unknown
  export function jsonToCollectionBru(json: unknown): string
}
