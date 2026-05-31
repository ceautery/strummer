/** Turns a query string into a query embedding for hybrid search. */
export interface Embedder {
  embed(query: string): Promise<number[]>
}

// Xenova's ONNX export of bge-small-en-v1.5 reproduces the Python `fastembed`
// document vectors exactly (verified cosine 1.0; ADR 0003), so query and
// document embeddings share one vector space.
const MODEL = 'Xenova/bge-small-en-v1.5'

// bge retrieval is asymmetric: queries get an instruction prefix, the indexed
// passages do not.
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '

type FeatureExtractor = (
  text: string,
  opts: { pooling: 'cls'; normalize: boolean },
) => Promise<{ data: ArrayLike<number> }>

/**
 * Lazy transformers.js embedder. The dependency is loaded dynamically through a
 * non-literal specifier so that consumer packages can typecheck against this
 * source without resolving the heavy `@huggingface/transformers` types; the
 * model loads on first use, then is reused.
 */
export class QueryEmbedder implements Embedder {
  private extractor?: Promise<FeatureExtractor>

  private load(): Promise<FeatureExtractor> {
    if (!this.extractor) {
      const moduleId: string = '@huggingface/transformers'
      this.extractor = import(moduleId).then((m) => m.pipeline('feature-extraction', MODEL))
    }
    return this.extractor
  }

  async embed(query: string): Promise<number[]> {
    const extractor = await this.load()
    const output = await extractor(QUERY_PREFIX + query, { pooling: 'cls', normalize: true })
    return Array.from(output.data, Number)
  }
}
