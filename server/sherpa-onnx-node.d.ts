// The part of sherpa-onnx-node (https://github.com/k2-fsa/sherpa-onnx) this app uses; the package ships no types.
declare module "sherpa-onnx-node" {
  const sherpa: {
    OfflineRecognizer: {
      createAsync(config: object): Promise<{
        createStream(): { acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void };
        decodeAsync(stream: unknown): Promise<{ text: string }>;
      }>;
    };
  };
  export default sherpa;
}
