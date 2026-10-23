// Scores a reconciliation result against the generator's answer key.
import type { AnswerKey, ReconResult } from './types';

export interface EvalResult {
  linkAccuracy: number;          // correct links / expected links
  wrongLinks: number;            // links made to the wrong record (the dangerous kind)
  paymentLinks: { correct: number; expected: number };
  bankLinks: { correct: number; expected: number };
  hard: { correct: number; total: number };
  exceptions: { tp: number; fp: number; fn: number; precision: number; recall: number };
  missed: string[];
  falseAlarms: string[];
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 100);

export function evaluate(r: ReconResult, key: AnswerKey): EvalResult {
  const pCorrect = r.paymentLinks.filter((l) => key.orderPayment[l.paymentId] === l.orderId).length;
  const pWrong = r.paymentLinks.length - pCorrect;
  const bCorrect = r.bankLinks.filter((l) => key.settlementBank[l.settlementId] === l.tranId).length;
  const bWrong = r.bankLinks.length - bCorrect;
  const pExp = Object.keys(key.orderPayment).length;
  const bExp = Object.keys(key.settlementBank).length;

  const hardP = new Set(key.hard.payments);
  const hardB = new Set(key.hard.bank);
  const hardCorrect =
    r.paymentLinks.filter((l) => hardP.has(l.paymentId) && key.orderPayment[l.paymentId] === l.orderId).length +
    r.bankLinks.filter((l) => hardB.has(l.tranId) && key.settlementBank[l.settlementId] === l.tranId).length;

  const truth = new Set(key.exceptions.map((e) => `${e.type}|${e.key}`));
  const pred = new Set(r.exceptions.map((e) => `${e.type}|${e.key}`));
  const tp = [...pred].filter((x) => truth.has(x)).length;
  const falseAlarms = [...pred].filter((x) => !truth.has(x));
  const missed = [...truth].filter((x) => !pred.has(x));

  return {
    linkAccuracy: pct(pCorrect + bCorrect, pExp + bExp),
    wrongLinks: pWrong + bWrong,
    paymentLinks: { correct: pCorrect, expected: pExp },
    bankLinks: { correct: bCorrect, expected: bExp },
    hard: { correct: hardCorrect, total: hardP.size + hardB.size },
    exceptions: { tp, fp: falseAlarms.length, fn: missed.length, precision: pct(tp, pred.size), recall: pct(tp, truth.size) },
    missed,
    falseAlarms,
  };
}
