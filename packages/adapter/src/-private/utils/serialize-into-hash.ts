import type { MinimumSerializerInterface, SerializerOptions } from '@ember-data/legacy-compat';
import { type Snapshot, upgradeStore } from '@ember-data/legacy-compat/-private';
import type Store from '@ember-data/store';
import type { ModelSchema } from '@ember-data/store/types';
import { assert } from '@warp-drive/build-config/macros';

type SerializerWithSerializeIntoHash = MinimumSerializerInterface & {
  serializeIntoHash?(hash: object, modelClass: ModelSchema, snapshot: Snapshot, options?: SerializerOptions): void;
};

export function serializeIntoHash(
  store: Store,
  modelClass: ModelSchema,
  snapshot: Snapshot,
  options: { includeId?: boolean } = { includeId: true }
) {
  upgradeStore(store);
  const serializer: SerializerWithSerializeIntoHash | null = store.serializerFor(modelClass.modelName);

  assert(`Cannot serialize record, no serializer defined`, serializer);

  if (typeof serializer.serializeIntoHash === 'function') {
    const data = {};
    serializer.serializeIntoHash(data, modelClass, snapshot, options);
    return data;
  }

  return serializer.serialize(snapshot, options);
}
