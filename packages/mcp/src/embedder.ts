import { type FeatureExtractionPipeline, pipeline } from '@huggingface/transformers'

/** Turns a query string into a query embedding for hybrid search. */
export interface Embedder {
  embed(query: string): Promise<number[]>
}

// Xenova's ONNX export of bge-small-en-v1.5 produces vectors identical to the
// Python `fastembed` model used at ingest time (verified cosine == 1.0), so the
// query and document embeddings live in the same space.
const MODEL = 'Xenova/bge-small-en-v1.5'

// bge retrieval is asymmetric: queries get an instruction prefix, passages
// (the indexed docs) do not.
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '

/** Lazy transformers.js embedder. The model loads on first use, then is reused. */
export class QueryEmbedder implements Embedder {
  private pipe: Promise<FeatureExtractionPipeline> | undefined

  private extractor(): Promise<FeatureExtractionPipeline> {
    if (!this.pipe) {
      this.pipe = pipeline('feature-extraction', MODEL)
    }
    return this.pipe
  }

  async embed(query: string): Promise<number[]> {
    const extractor = await this.extractor()
    const output = await extractor(QUERY_PREFIX + query, { pooling: 'cls', normalize: true })
    return Array.from(output.data as Float32Array, Number)
  }
}
