const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

function varint(value: number): Buffer {
  const bytes: number[] = [];
  do {
    bytes.push((value & 127) | (value > 127 ? 128 : 0));
    value = Math.floor(value / 128);
  } while (value);
  return Buffer.from(bytes);
}

export function bytesField(field: number, value: Uint8Array): Buffer {
  return Buffer.concat([varint(field * 8 + 2), varint(value.length), value]);
}
export function textField(field: number, value: string): Buffer {
  return bytesField(field, Buffer.from(value));
}
export function scalarField(field: number, value: number): Buffer {
  return Buffer.concat([varint(field * 8), varint(value)]);
}
export function boolField(field: number, value = true): Buffer {
  return scalarField(field, Number(value));
}

export function setupMessage(model: string, language?: string): Buffer {
  return bytesField(1, Buffer.concat([
    textField(1, model),
    bytesField(5, bytesField(6, boolField(1))),
    bytesField(8, language ? bytesField(3, textField(1, language)) : Buffer.alloc(0)),
  ]));
}
export function contextMessage(context?: string, vocabulary?: string[]): Buffer | undefined {
  const text = [context, vocabulary?.length ? `Vocabulary: ${vocabulary.join(', ')}` : undefined].filter(Boolean).join('\n');
  if (!text) return undefined;
  const content = bytesField(2, textField(1, text));
  const asr = Buffer.concat([scalarField(1, 2), scalarField(2, 2), bytesField(3, content)]);
  // NAM target=2, REPLACE mode=2. Content contains repeated Part field 2.
  return bytesField(6, bytesField(5, asr));
}
export function activityMessage(start: boolean): Buffer {
  return bytesField(3, bytesField(start ? 5 : 6, Buffer.alloc(0)));
}
export function audioMessage(pcm: Uint8Array): Buffer {
  return bytesField(3, bytesField(1, Buffer.concat([
    textField(1, 'audio/pcm;rate=16000'), bytesField(2, pcm),
  ])));
}
export function audioEndMessage(): Buffer { return bytesField(3, boolField(2)); }

interface Field { number: number; wire: number; bytes?: Buffer; value?: number }
function fields(data: Buffer): Field[] {
  let offset = 0;
  function readVarint(): number {
    let value = 0;
    for (let i = 0; i < 10; i++) {
      if (offset >= data.length) throw new Error('Truncated protobuf varint');
      const byte = data[offset++]!;
      value += (byte & 127) * 2 ** (7 * i);
      if (!(byte & 128)) {
        if (!Number.isSafeInteger(value)) throw new Error('Oversized protobuf varint');
        return value;
      }
    }
    throw new Error('Oversized protobuf varint');
  }
  const result: Field[] = [];
  while (offset < data.length) {
    if (result.length >= 65_536) throw new Error('Too many protobuf fields');
    const tag = readVarint();
    const number = Math.floor(tag / 8), wire = tag & 7;
    if (!number) throw new Error('Invalid protobuf field');
    if (wire === 0) result.push({ number, wire, value: readVarint() });
    else {
      const length = wire === 2 ? readVarint() : wire === 1 ? 8 : wire === 5 ? 4 : -1;
      if (length < 0 || length > MAX_MESSAGE_BYTES || offset + length > data.length) {
        throw new Error('Invalid protobuf field length');
      }
      result.push({ number, wire, bytes: data.subarray(offset, offset + length) });
      offset += length;
    }
  }
  return result;
}

export interface SpeechResponse {
  setupComplete: boolean;
  turnComplete: boolean;
  transcripts: { kind: 'draft' | 'final'; text: string; finished: boolean }[];
}
export function decodeSpeechResponse(data: Buffer): SpeechResponse {
  if (data.length > MAX_MESSAGE_BYTES) throw new Error('Oversized protobuf message');
  const result: SpeechResponse = { setupComplete: false, turnComplete: false, transcripts: [] };
  for (const top of fields(data)) {
    if (top.number === 1 && top.wire === 2) result.setupComplete = true;
    if (top.number !== 2 || top.wire !== 2) continue;
    for (const field of fields(top.bytes!)) {
      if (field.number === 3 && field.wire === 0) result.turnComplete = field.value !== 0;
      if (![6, 11].includes(field.number) || field.wire !== 2) continue;
      const transcription = fields(field.bytes!);
      const text = transcription.find((item) => item.number === 1 && item.wire === 2)?.bytes?.toString('utf8') ?? '';
      const finished = (transcription.find((item) => item.number === 2 && item.wire === 0)?.value ?? 0) !== 0;
      result.transcripts.push({ kind: field.number === 6 ? 'final' : 'draft', text, finished });
    }
  }
  return result;
}

export function grpcFrame(message: Uint8Array): Buffer {
  if (message.length > MAX_MESSAGE_BYTES) throw new Error('Oversized gRPC message');
  const header = Buffer.alloc(5);
  header.writeUInt32BE(message.length, 1);
  return Buffer.concat([header, message]);
}
export class GrpcFrameDecoder {
  private pending = Buffer.alloc(0);
  push(chunk: Uint8Array): Buffer[] {
    // HTTP/2 bounds individual network chunks; never retain an oversized declared message.
    this.pending = Buffer.concat([this.pending, chunk]);
    const messages: Buffer[] = [];
    while (this.pending.length >= 5) {
      if (this.pending[0] !== 0) throw new Error('Compressed gRPC messages are unsupported');
      const length = this.pending.readUInt32BE(1);
      if (length > MAX_MESSAGE_BYTES) throw new Error('Oversized gRPC message');
      if (this.pending.length < length + 5) break;
      messages.push(this.pending.subarray(5, 5 + length));
      this.pending = this.pending.subarray(5 + length);
    }
    return messages;
  }
  finish(): void {
    if (this.pending.length) throw new Error('Truncated gRPC frame');
  }
}
