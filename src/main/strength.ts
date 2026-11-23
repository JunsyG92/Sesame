import { ZxcvbnFactory } from '@zxcvbn-ts/core';
import * as common from '@zxcvbn-ts/language-common';

let factory: ZxcvbnFactory | null = null;

/** zxcvbn score (0 = very weak … 4 = very strong). */
export function passwordScore(password: string): number {
  factory ??= new ZxcvbnFactory({
    dictionary: { ...common.dictionary },
    graphs: common.adjacencyGraphs,
  });
  // zxcvbn is quadratic on very long inputs; 128 characters is plenty for scoring.
  return factory.check(password.slice(0, 128)).score;
}
