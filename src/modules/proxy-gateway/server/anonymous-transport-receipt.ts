import type http from 'node:http';
import type http2 from 'node:http2';
import { logger } from '../../../shared/logging/logger';
import { formatSafeEvent } from '../../../shared/logging/safe-event';

export type ReceiptClassification =
  | 'validated_response'
  | 'invalid_authority'
  | 'request_too_large'
  | 'unavailable'
  | 'rate_limited'
  | 'bad_gateway'
  | 'deadline_exceeded'
  | 'client_aborted'
  | 'internal_error';

export interface AnonymousTransportReceipt {
  receiptId: string;
  classification: ReceiptClassification;
  downstreamCommitCount: 0 | 1;
  result: 'committed' | 'rejected';
}

type Response = http.ServerResponse | http2.Http2ServerResponse;

/** One owner follows a request across the gateway/ingress exception boundary. */
export class AnonymousTransportReceiptOwner {
  private classification: ReceiptClassification = 'internal_error';
  private expectedCommit: ReceiptClassification | null = null;
  private committed = false;
  private emitted = false;

  constructor(readonly receiptId: string) {}

  observeResponse(res: Response): void {
    res.once('finish', () => {
      if (this.expectedCommit) {
        this.classification = this.expectedCommit;
        this.committed = true;
      }
    });
    res.once('close', () => {
      if (!this.committed && this.expectedCommit) this.classification = this.expectedCommit;
    });
  }

  expectDownstreamCommit(classification: ReceiptClassification): void {
    if (!this.committed) this.expectedCommit = classification;
  }

  reject(classification: ReceiptClassification): void {
    if (!this.committed) {
      this.expectedCommit = null;
      this.classification = classification;
    }
  }

  emit(): void {
    if (this.emitted) return;
    this.emitted = true;
    const receipt: AnonymousTransportReceipt = {
      receiptId: this.receiptId,
      classification: this.classification,
      downstreamCommitCount: this.committed ? 1 : 0,
      result: this.committed ? 'committed' : 'rejected',
    };
    try {
      logger.info(formatSafeEvent('anonymous_transport_receipt', {
        receiptId: receipt.receiptId,
        classification: receipt.classification,
        downstreamCommitCount: receipt.downstreamCommitCount,
        result: receipt.result,
      }, [
        'receiptId',
        'classification',
        'downstreamCommitCount',
        'result',
      ]));
    } catch {
      // A logging sink must not retry or alter the terminal transport result.
    }
  }
}
