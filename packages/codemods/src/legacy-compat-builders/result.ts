import type { ParsedImportInfo } from '../utils/imports.js';

export class TransformResult {
  attemptedTransform = false;

  importsToAdd = new Set<ParsedImportInfo>();

  merge(other: TransformResult): void {
    other.importsToAdd.forEach((importToAdd) => this.importsToAdd.add(importToAdd));
    this.attemptedTransform = this.attemptedTransform || other.attemptedTransform;
  }
}
