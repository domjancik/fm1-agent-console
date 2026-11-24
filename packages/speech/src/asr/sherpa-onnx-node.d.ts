// Minimal typings for the parts of sherpa-onnx-node@2.0.1 we use (the package ships none).
declare module "sherpa-onnx-node" {
  export interface OfflineRecognizerConfig {
    featConfig: { sampleRate: number; featureDim: number };
    modelConfig: {
      transducer: { encoder: string; decoder: string; joiner: string };
      tokens: string;
      numThreads: number;
      provider: "cpu" | "coreml";
      modelType: "nemo_transducer";
      debug: 0 | 1;
    };
    decodingMethod: "greedy_search" | "modified_beam_search";
  }
  export class OfflineStream {
    acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
  }
  export class OfflineRecognizer {
    constructor(config: OfflineRecognizerConfig);
    static createAsync(config: OfflineRecognizerConfig): Promise<OfflineRecognizer>;
    createStream(hotwords?: string): OfflineStream;
    decode(stream: OfflineStream): void;
    decodeAsync(stream: OfflineStream): Promise<void>;
    getResult(stream: OfflineStream): { text: string };
  }
  export const version: string;
}
