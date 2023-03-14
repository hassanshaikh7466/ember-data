/**
 * @module @ember-data/json-api
 */
import { assert } from '@ember/debug';
import { schedule } from '@ember/runloop';
import { DEBUG } from '@glimmer/env';

import { graphFor, peekGraph } from '@ember-data/graph/-private';
import type { LocalRelationshipOperation } from '@ember-data/graph/-private/graph/-operations';
import type { ImplicitRelationship } from '@ember-data/graph/-private/graph/index';
import type BelongsToRelationship from '@ember-data/graph/-private/relationships/state/belongs-to';
import type ManyRelationship from '@ember-data/graph/-private/relationships/state/has-many';
import { LOG_MUTATIONS, LOG_OPERATIONS } from '@ember-data/private-build-infra/debugging';
import { IdentifierCache } from '@ember-data/store/-private/caches/identifier-cache';
import { ResourceDocument, StructuredDocument } from '@ember-data/types/cache/document';
import type { Cache, ChangedAttributesHash, MergeOperation } from '@ember-data/types/q/cache';
import type { CacheStoreWrapper, V2CacheStoreWrapper } from '@ember-data/types/q/cache-store-wrapper';
import type {
  CollectionResourceRelationship,
  ExistingResourceObject,
  JsonApiDocument,
  SingleResourceRelationship,
} from '@ember-data/types/q/ember-data-json-api';
import type { StableExistingRecordIdentifier, StableRecordIdentifier } from '@ember-data/types/q/identifier';
import type { AttributesHash, JsonApiResource, JsonApiValidationError } from '@ember-data/types/q/record-data-json-api';
import type { AttributeSchema, RelationshipSchema } from '@ember-data/types/q/record-data-schemas';
import type { Dict } from '@ember-data/types/q/utils';

function isImplicit(
  relationship: ManyRelationship | ImplicitRelationship | BelongsToRelationship
): relationship is ImplicitRelationship {
  return relationship.definition.isImplicit;
}

const EMPTY_ITERATOR = {
  iterator() {
    return {
      next() {
        return { done: true, value: undefined };
      },
    };
  },
};

interface CachedResource {
  remoteAttrs: Dict<unknown> | null;
  localAttrs: Dict<unknown> | null;
  inflightAttrs: Dict<unknown> | null;
  changes: Dict<unknown[]> | null;
  errors: JsonApiValidationError[] | null;
  isNew: boolean;
  isDeleted: boolean;
  isDeletionCommitted: boolean;
}

function makeCache(): CachedResource {
  return {
    remoteAttrs: null,
    localAttrs: null,
    inflightAttrs: null,
    changes: null,
    errors: null,
    isNew: false,
    isDeleted: false,
    isDeletionCommitted: false,
  };
}

/**
  A JSON:API Cache implementation.

  What cache the store uses is configurable. Using a different
  implementation can be achieved by implementing the store's
  createCache hook.

  This is the cache implementation used by `ember-data`.

  @class Cache
  @public
 */

export default class SingletonCache implements Cache {
  version: '2' = '2';

  __storeWrapper: V2CacheStoreWrapper;
  __cache: Map<StableRecordIdentifier, CachedResource> = new Map();
  __destroyedCache: Map<StableRecordIdentifier, CachedResource> = new Map();

  constructor(storeWrapper: V2CacheStoreWrapper) {
    this.__storeWrapper = storeWrapper;
  }

  put<T extends JsonApiDocument>(doc: StructuredDocument<T>): ResourceDocument {
    assert(`Cannot currently cache an ErrorDocument`, !('error' in doc));
    const jsonApiDoc = doc.data;
    let included = jsonApiDoc.included;
    let i: number, length: number;
    const { identifierCache } = this.__storeWrapper;

    if (included) {
      for (i = 0, length = included.length; i < length; i++) {
        putOne(this, identifierCache, included[i]);
      }
    }

    if (Array.isArray(jsonApiDoc.data)) {
      length = jsonApiDoc.data.length;
      let identifiers: StableExistingRecordIdentifier[] = [];

      for (i = 0; i < length; i++) {
        identifiers.push(putOne(this, identifierCache, jsonApiDoc.data[i]));
      }
      return { data: identifiers };
    }

    if (jsonApiDoc.data === null) {
      return { data: null };
    }

    assert(
      `Expected an object in the 'data' property in a call to 'push', but was ${typeof jsonApiDoc.data}`,
      typeof jsonApiDoc.data === 'object'
    );

    let identifier = putOne(this, identifierCache, jsonApiDoc.data);
    return { data: identifier };
  }

  /**
   * Private method used to populate an entry for the identifier
   *
   * @method _createCache
   * @private
   * @param identifier
   */
  _createCache(identifier: StableRecordIdentifier): CachedResource {
    assert(`Expected no resource data to yet exist in the cache`, !this.__cache.has(identifier));
    const cache = makeCache();
    this.__cache.set(identifier, cache);
    return cache;
  }

  __safePeek(identifier: StableRecordIdentifier, allowDestroyed: boolean): CachedResource | undefined {
    let resource = this.__cache.get(identifier);
    if (!resource && allowDestroyed) {
      resource = this.__destroyedCache.get(identifier);
    }
    return resource;
  }

  __peek(identifier: StableRecordIdentifier, allowDestroyed: boolean): CachedResource {
    let resource = this.__safePeek(identifier, allowDestroyed);
    assert(
      `Expected Cache to have a resource entry for the identifier ${String(identifier)} but none was found`,
      resource
    );
    return resource;
  }

  upsert(
    identifier: StableRecordIdentifier,
    data: JsonApiResource,
    calculateChanges?: boolean | undefined
  ): void | string[] {
    let changedKeys: string[] | undefined;
    const peeked = this.__safePeek(identifier, false);
    const existed = !!peeked;
    const cached = peeked || this._createCache(identifier);

    const isLoading = _isLoading(peeked, this.__storeWrapper, identifier) || !recordIsLoaded(peeked);
    let isUpdate = !_isEmpty(peeked) && !isLoading;

    if (LOG_OPERATIONS) {
      try {
        let _data = JSON.parse(JSON.stringify(data));
        // eslint-disable-next-line no-console
        console.log(`EmberData | Operation - upsert (${existed ? 'merge' : 'insert'})`, _data);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.log(`EmberData | Operation - upsert (${existed ? 'merge' : 'insert'})`, data);
      }
    }

    if (cached.isNew) {
      cached.isNew = false;
      this.__storeWrapper.notifyChange(identifier, 'identity');
      this.__storeWrapper.notifyChange(identifier, 'state');
    }

    if (calculateChanges) {
      changedKeys = existed ? calculateChangedKeys(cached, data.attributes) : Object.keys(data.attributes || {});
    }

    cached.remoteAttrs = Object.assign(cached.remoteAttrs || Object.create(null), data.attributes);
    if (cached.localAttrs) {
      if (patchLocalAttributes(cached)) {
        this.__storeWrapper.notifyChange(identifier, 'state');
      }
    }

    if (!isUpdate) {
      this.__storeWrapper.notifyChange(identifier, 'added');
    }

    if (data.relationships) {
      setupRelationships(this.__storeWrapper, identifier, data);
    }

    if (changedKeys && changedKeys.length) {
      notifyAttributes(this.__storeWrapper, identifier, changedKeys);
    }

    return changedKeys;
  }

  patch(op: MergeOperation): void {
    if (LOG_OPERATIONS) {
      try {
        let _data = JSON.parse(JSON.stringify(op));
        // eslint-disable-next-line no-console
        console.log(`EmberData | Operation - sync ${op.op}`, _data);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.log(`EmberData | Operation - sync ${op.op}`, op);
      }
    }
    if (op.op === 'mergeIdentifiers') {
      const cache = this.__cache.get(op.record);
      if (cache) {
        this.__cache.set(op.value, cache);
        this.__cache.delete(op.record);
      }
      graphFor(this.__storeWrapper).update(op, true);
    }
  }

  update(op: LocalRelationshipOperation): void {
    if (LOG_MUTATIONS) {
      try {
        let _data = JSON.parse(JSON.stringify(op));
        // eslint-disable-next-line no-console
        console.log(`EmberData | Mutation - update ${op.op}`, _data);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.log(`EmberData | Mutation - update ${op.op}`, op);
      }
    }
    graphFor(this.__storeWrapper).update(op, false);
  }

  clientDidCreate(identifier: StableRecordIdentifier, options?: Dict<unknown> | undefined): Dict<unknown> {
    if (LOG_MUTATIONS) {
      try {
        let _data = options ? JSON.parse(JSON.stringify(options)) : options;
        // eslint-disable-next-line no-console
        console.log(`EmberData | Mutation - clientDidCreate ${identifier.lid}`, _data);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.log(`EmberData | Mutation - clientDidCreate ${identifier.lid}`, options);
      }
    }
    const cached = this._createCache(identifier);
    cached.isNew = true;
    let createOptions = {};

    if (options !== undefined) {
      const storeWrapper = this.__storeWrapper;
      let attributeDefs = storeWrapper.getSchemaDefinitionService().attributesDefinitionFor(identifier);
      let relationshipDefs = storeWrapper.getSchemaDefinitionService().relationshipsDefinitionFor(identifier);
      const graph = graphFor(storeWrapper);
      let propertyNames = Object.keys(options);

      for (let i = 0; i < propertyNames.length; i++) {
        let name = propertyNames[i];
        let propertyValue = options[name];

        if (name === 'id') {
          continue;
        }

        const fieldType: AttributeSchema | RelationshipSchema | undefined =
          relationshipDefs[name] || attributeDefs[name];
        let kind = fieldType !== undefined ? ('kind' in fieldType ? fieldType.kind : 'attribute') : null;
        let relationship;

        switch (kind) {
          case 'attribute':
            this.setAttr(identifier, name, propertyValue);
            break;
          case 'belongsTo':
            this.update({
              op: 'replaceRelatedRecord',
              field: name,
              record: identifier,
              value: propertyValue as StableRecordIdentifier | null,
            });
            relationship = graph.get(identifier, name);
            relationship.state.hasReceivedData = true;
            relationship.state.isEmpty = false;
            break;
          case 'hasMany':
            this.update({
              op: 'replaceRelatedRecords',
              field: name,
              record: identifier,
              value: propertyValue as StableRecordIdentifier[],
            });
            relationship = graph.get(identifier, name);
            relationship.state.hasReceivedData = true;
            relationship.state.isEmpty = false;
            break;
          default:
            // reflect back (pass-thru) unknown properties
            createOptions[name] = propertyValue;
        }
      }
    }

    this.__storeWrapper.notifyChange(identifier, 'added');

    return createOptions;
  }
  willCommit(identifier: StableRecordIdentifier): void {
    const cached = this.__peek(identifier, false);
    cached.inflightAttrs = cached.localAttrs;
    cached.localAttrs = null;
  }
  didCommit(identifier: StableRecordIdentifier, data: JsonApiResource | null): void {
    const cached = this.__peek(identifier, false);
    if (cached.isDeleted) {
      graphFor(this.__storeWrapper).push({
        op: 'deleteRecord',
        record: identifier,
        isNew: false,
      });
      cached.isDeletionCommitted = true;
      this.__storeWrapper.notifyChange(identifier, 'removed');
      // TODO @runspired should we early exit here?
    }

    if (DEBUG) {
      if (cached.isNew && !identifier.id && (typeof data?.id !== 'string' || data.id.length > 0)) {
        const error = new Error(`Expected an id ${String(identifier)} in response ${JSON.stringify(data)}`);
        //@ts-expect-error
        error.isAdapterError = true;
        //@ts-expect-error
        error.code = 'InvalidError';
        throw error;
      }
    }

    cached.isNew = false;
    let newCanonicalAttributes: AttributesHash | undefined;
    if (data) {
      if (data.id) {
        // didCommit provided an ID, notify the store of it
        assert(
          `Expected resource id to be a string, got a value of type ${typeof data.id}`,
          typeof data.id === 'string'
        );
        this.__storeWrapper.setRecordId(identifier, data.id);
      }
      if (data.relationships) {
        setupRelationships(this.__storeWrapper, identifier, data);
      }
      newCanonicalAttributes = data.attributes;
    }
    let changedKeys = calculateChangedKeys(cached, newCanonicalAttributes);

    cached.remoteAttrs = Object.assign(
      cached.remoteAttrs || Object.create(null),
      cached.inflightAttrs,
      newCanonicalAttributes
    );
    cached.inflightAttrs = null;
    patchLocalAttributes(cached);

    if (cached.errors) {
      cached.errors = null;
      this.__storeWrapper.notifyChange(identifier, 'errors');
    }

    notifyAttributes(this.__storeWrapper, identifier, changedKeys);
    this.__storeWrapper.notifyChange(identifier, 'state');
  }

  commitWasRejected(identifier: StableRecordIdentifier, errors?: JsonApiValidationError[] | undefined): void {
    const cached = this.__peek(identifier, false);
    if (cached.inflightAttrs) {
      let keys = Object.keys(cached.inflightAttrs);
      if (keys.length > 0) {
        let attrs = (cached.localAttrs = cached.localAttrs || Object.create(null));
        for (let i = 0; i < keys.length; i++) {
          if (attrs[keys[i]] === undefined) {
            attrs[keys[i]] = cached.inflightAttrs[keys[i]];
          }
        }
      }
      cached.inflightAttrs = null;
    }
    if (errors) {
      cached.errors = errors;
    }
    this.__storeWrapper.notifyChange(identifier, 'errors');
  }

  unloadRecord(identifier: StableRecordIdentifier): void {
    // TODO this is necessary because
    // we maintain memebership inside InstanceCache
    // for peekAll, so even though we haven't created
    // any data we think this exists.
    // TODO can we eliminate that membership now?
    if (!this.__cache.has(identifier)) {
      return;
    }
    const removeFromRecordArray = !this.isDeletionCommitted(identifier);
    let removed = false;
    const cached = this.__peek(identifier, false);
    const storeWrapper = this.__storeWrapper;
    peekGraph(storeWrapper)?.unload(identifier);

    // effectively clearing these is ensuring that
    // we report as `isEmpty` during teardown.
    cached.localAttrs = null;
    cached.remoteAttrs = null;
    cached.inflightAttrs = null;

    let relatedIdentifiers = _allRelatedIdentifiers(storeWrapper, identifier);
    if (areAllModelsUnloaded(storeWrapper, relatedIdentifiers)) {
      for (let i = 0; i < relatedIdentifiers.length; ++i) {
        let identifier = relatedIdentifiers[i];
        storeWrapper.notifyChange(identifier, 'removed');
        removed = true;
        storeWrapper.disconnectRecord(identifier);
      }
    }

    this.__cache.delete(identifier);
    this.__destroyedCache.set(identifier, cached);

    /*
     * The destroy cache is a hack to prevent applications
     * from blowing up during teardown. Accessing state
     * on a destroyed record is not safe, but historically
     * was possible due to a combination of teardown timing
     * and retention of cached state directly on the
     * record itself.
     *
     * Once we have deprecated accessing state on a destroyed
     * instance we may remove this. The timing isn't a huge deal
     * as momentarily retaining the objects outside the bounds
     * of a test won't cause issues.
     */
    if (this.__destroyedCache.size === 1) {
      schedule('destroy', () => {
        setTimeout(() => {
          this.__destroyedCache.clear();
        }, 100);
      });
    }

    if (!removed && removeFromRecordArray) {
      storeWrapper.notifyChange(identifier, 'removed');
    }
  }

  getAttr(identifier: StableRecordIdentifier, attr: string): unknown {
    const cached = this.__peek(identifier, true);
    if (cached.localAttrs && attr in cached.localAttrs) {
      return cached.localAttrs[attr];
    } else if (cached.inflightAttrs && attr in cached.inflightAttrs) {
      return cached.inflightAttrs[attr];
    } else if (cached.remoteAttrs && attr in cached.remoteAttrs) {
      return cached.remoteAttrs[attr];
    } else {
      const attrSchema = this.__storeWrapper.getSchemaDefinitionService().attributesDefinitionFor(identifier)[attr];
      return getDefaultValue(attrSchema?.options);
    }
  }
  setAttr(identifier: StableRecordIdentifier, attr: string, value: unknown): void {
    const cached = this.__peek(identifier, false);
    const existing =
      cached.inflightAttrs && attr in cached.inflightAttrs
        ? cached.inflightAttrs[attr]
        : cached.remoteAttrs && attr in cached.remoteAttrs
        ? cached.remoteAttrs[attr]
        : undefined;
    if (existing !== value) {
      cached.localAttrs = cached.localAttrs || Object.create(null);
      cached.localAttrs![attr] = value;
      cached.changes = cached.changes || Object.create(null);
      cached.changes![attr] = [existing, value];
    } else if (cached.localAttrs) {
      delete cached.localAttrs[attr];
      delete cached.changes![attr];
    }

    this.__storeWrapper.notifyChange(identifier, 'attributes', attr);
  }
  changedAttrs(identifier: StableRecordIdentifier): ChangedAttributesHash {
    // TODO freeze in dev
    return this.__peek(identifier, false).changes || Object.create(null);
  }
  hasChangedAttrs(identifier: StableRecordIdentifier): boolean {
    const cached = this.__peek(identifier, true);

    return (
      (cached.inflightAttrs !== null && Object.keys(cached.inflightAttrs).length > 0) ||
      (cached.localAttrs !== null && Object.keys(cached.localAttrs).length > 0)
    );
  }
  rollbackAttrs(identifier: StableRecordIdentifier): string[] {
    const cached = this.__peek(identifier, false);
    let dirtyKeys: string[] | undefined;
    cached.isDeleted = false;

    if (cached.localAttrs !== null) {
      dirtyKeys = Object.keys(cached.localAttrs);
      cached.localAttrs = null;
      cached.changes = null;
    }

    if (cached.isNew) {
      graphFor(this.__storeWrapper).push({
        op: 'deleteRecord',
        record: identifier,
        isNew: true,
      });
      cached.isDeleted = true;
      cached.isNew = false;
    }

    cached.inflightAttrs = null;

    if (cached.errors) {
      cached.errors = null;
      this.__storeWrapper.notifyChange(identifier, 'errors');
    }

    this.__storeWrapper.notifyChange(identifier, 'state');

    if (dirtyKeys && dirtyKeys.length) {
      notifyAttributes(this.__storeWrapper, identifier, dirtyKeys);
    }

    return dirtyKeys || [];
  }

  getRelationship(
    identifier: StableRecordIdentifier,
    field: string
  ): SingleResourceRelationship | CollectionResourceRelationship {
    return (graphFor(this.__storeWrapper).get(identifier, field) as BelongsToRelationship | ManyRelationship).getData();
  }

  setIsDeleted(identifier: StableRecordIdentifier, isDeleted: boolean): void {
    const cached = this.__peek(identifier, false);
    cached.isDeleted = isDeleted;
    if (cached.isNew) {
      // TODO can we delete this since we will do this in unload?
      graphFor(this.__storeWrapper).push({
        op: 'deleteRecord',
        record: identifier,
        isNew: true,
      });
    }
    this.__storeWrapper.notifyChange(identifier, 'state');
  }
  getErrors(identifier: StableRecordIdentifier): JsonApiValidationError[] {
    return this.__peek(identifier, true).errors || [];
  }
  isEmpty(identifier: StableRecordIdentifier): boolean {
    const cached = this.__safePeek(identifier, true);
    return cached ? cached.remoteAttrs === null && cached.inflightAttrs === null && cached.localAttrs === null : true;
  }
  isNew(identifier: StableRecordIdentifier): boolean {
    // TODO can we assert here?
    return this.__safePeek(identifier, true)?.isNew || false;
  }
  isDeleted(identifier: StableRecordIdentifier): boolean {
    // TODO can we assert here?
    return this.__safePeek(identifier, true)?.isDeleted || false;
  }
  isDeletionCommitted(identifier: StableRecordIdentifier): boolean {
    // TODO can we assert here?
    return this.__safePeek(identifier, true)?.isDeletionCommitted || false;
  }
}

function areAllModelsUnloaded(wrapper: V2CacheStoreWrapper, identifiers: StableRecordIdentifier[]): boolean {
  for (let i = 0; i < identifiers.length; ++i) {
    let identifier = identifiers[i];
    if (wrapper.hasRecord(identifier)) {
      return false;
    }
  }
  return true;
}

function getLocalState(rel) {
  if (rel.definition.kind === 'belongsTo') {
    return rel.localState ? [rel.localState] : [];
  }
  return rel.localState;
}
function getRemoteState(rel) {
  if (rel.definition.kind === 'belongsTo') {
    return rel.remoteState ? [rel.remoteState] : [];
  }
  return rel.remoteState;
}

function getDefaultValue(options: { defaultValue?: unknown } | undefined) {
  if (!options) {
    return;
  }
  if (typeof options.defaultValue === 'function') {
    // If anyone opens an issue for args not working right, we'll restore + deprecate it via a Proxy
    // that lazily instantiates the record. We don't want to provide any args here
    // because in a non @ember-data/model world they don't make sense.
    return options.defaultValue();
  } else {
    let defaultValue = options.defaultValue;
    assert(
      `Non primitive defaultValues are not supported because they are shared between all instances. If you would like to use a complex object as a default value please provide a function that returns the complex object.`,
      typeof defaultValue !== 'object' || defaultValue === null
    );
    return defaultValue;
  }
}

function notifyAttributes(storeWrapper: CacheStoreWrapper, identifier: StableRecordIdentifier, keys?: string[]) {
  if (!keys) {
    storeWrapper.notifyChange(identifier, 'attributes');
    return;
  }

  for (let i = 0; i < keys.length; i++) {
    storeWrapper.notifyChange(identifier, 'attributes', keys[i]);
  }
}

/*
      TODO @deprecate IGOR DAVID
      There seems to be a potential bug here, where we will return keys that are not
      in the schema
  */
function calculateChangedKeys(cached: CachedResource, updates?: AttributesHash) {
  let changedKeys: string[] = [];

  if (updates) {
    const keys = Object.keys(updates);
    const length = keys.length;
    const localAttrs = cached.localAttrs;

    const original = Object.assign(Object.create(null), cached.remoteAttrs, cached.inflightAttrs);

    for (let i = 0; i < length; i++) {
      let key = keys[i];
      let value = updates[key];

      // A value in localAttrs means the user has a local change to
      // this attribute. We never override this value when merging
      // updates from the backend so we should not sent a change
      // notification if the server value differs from the original.
      if (localAttrs && localAttrs[key] !== undefined) {
        continue;
      }

      if (original[key] !== value) {
        changedKeys.push(key);
      }
    }
  }

  return changedKeys;
}

function cacheIsEmpty(cached: CachedResource | undefined): boolean {
  return !cached || (cached.remoteAttrs === null && cached.inflightAttrs === null && cached.localAttrs === null);
}

function _isEmpty(peeked: CachedResource | undefined): boolean {
  if (!peeked) {
    return true;
  }
  const isNew = peeked.isNew;
  const isDeleted = peeked.isDeleted;
  const isEmpty = cacheIsEmpty(peeked);

  return (!isNew || isDeleted) && isEmpty;
}

function recordIsLoaded(cached: CachedResource | undefined, filterDeleted: boolean = false): boolean {
  if (!cached) {
    return false;
  }
  const isNew = cached.isNew;
  const isEmpty = cacheIsEmpty(cached);

  // if we are new we must consider ourselves loaded
  if (isNew) {
    return !cached.isDeleted;
  }
  // even if we have a past request, if we are now empty we are not loaded
  // typically this is true after an unloadRecord call

  // if we are not empty, not new && we have a fulfilled request then we are loaded
  // we should consider allowing for something to be loaded that is simply "not empty".
  // which is how RecordState currently handles this case; however, RecordState is buggy
  // in that it does not account for unloading.
  return filterDeleted && cached.isDeletionCommitted ? false : !isEmpty;
}

function _isLoading(
  peeked: CachedResource | undefined,
  storeWrapper: CacheStoreWrapper,
  identifier: StableRecordIdentifier
): boolean {
  // TODO refactor things such that the cache is not required to know
  // about isLoading
  // @ts-expect-error
  const req = storeWrapper._store.getRequestStateService();
  // const fulfilled = req.getLastRequestForRecord(identifier);
  const isLoaded = recordIsLoaded(peeked);

  return (
    !isLoaded &&
    // fulfilled === null &&
    req.getPendingRequestsForRecord(identifier).some((req) => req.type === 'query')
  );
}

function setupRelationships(
  storeWrapper: CacheStoreWrapper,
  identifier: StableRecordIdentifier,
  data: JsonApiResource
) {
  // TODO @runspired iterating by definitions instead of by payload keys
  // allows relationship payloads to be ignored silently if no relationship
  // definition exists. Ensure there's a test for this and then consider
  // moving this to an assertion. This check should possibly live in the graph.
  const relationships = storeWrapper.getSchemaDefinitionService().relationshipsDefinitionFor(identifier);
  const keys = Object.keys(relationships);
  for (let i = 0; i < keys.length; i++) {
    const relationshipName = keys[i];
    const relationshipData = data.relationships![relationshipName];

    if (!relationshipData) {
      continue;
    }

    graphFor(storeWrapper).push({
      op: 'updateRelationship',
      record: identifier,
      field: relationshipName,
      value: relationshipData,
    });
  }
}

function patchLocalAttributes(cached: CachedResource): boolean {
  const { localAttrs, remoteAttrs, inflightAttrs, changes } = cached;
  if (!localAttrs) {
    cached.changes = null;
    return false;
  }
  let hasAppliedPatch = false;
  let mutatedKeys = Object.keys(localAttrs);

  for (let i = 0, length = mutatedKeys.length; i < length; i++) {
    let attr = mutatedKeys[i];
    const existing =
      inflightAttrs && attr in inflightAttrs
        ? inflightAttrs[attr]
        : remoteAttrs && attr in remoteAttrs
        ? remoteAttrs[attr]
        : undefined;

    if (existing === localAttrs[attr]) {
      hasAppliedPatch = true;
      delete localAttrs[attr];
      delete changes![attr];
    }
  }
  return hasAppliedPatch;
}

function putOne(
  cache: SingletonCache,
  identifiers: IdentifierCache,
  resource: ExistingResourceObject
): StableExistingRecordIdentifier {
  let identifier: StableRecordIdentifier | undefined = identifiers.peekRecordIdentifier(resource);

  if (identifier) {
    identifier = identifiers.updateRecordIdentifier(identifier, resource);
  } else {
    identifier = identifiers.getOrCreateRecordIdentifier(resource);
  }
  cache.upsert(identifier, resource, cache.__storeWrapper.hasRecord(identifier));
  // even if the identifier was not "existing" before, it is now
  return identifier as StableExistingRecordIdentifier;
}

/*
    Iterates over the set of internal models reachable from `this` across exactly one
    relationship.
  */
function _directlyRelatedIdentifiersIterable(storeWrapper: CacheStoreWrapper, originating: StableRecordIdentifier) {
  const graph = peekGraph(storeWrapper);
  const initializedRelationships = graph?.identifiers.get(originating);

  if (!initializedRelationships) {
    return EMPTY_ITERATOR;
  }

  const initializedRelationshipsArr: Array<ManyRelationship | BelongsToRelationship> = [];
  Object.keys(initializedRelationships).forEach((key) => {
    const rel = initializedRelationships[key];
    if (rel && !isImplicit(rel)) {
      initializedRelationshipsArr.push(rel);
    }
  });

  let i = 0;
  let j = 0;
  let k = 0;

  const findNext = () => {
    while (i < initializedRelationshipsArr.length) {
      while (j < 2) {
        let relatedIdentifiers =
          j === 0 ? getLocalState(initializedRelationshipsArr[i]) : getRemoteState(initializedRelationshipsArr[i]);
        while (k < relatedIdentifiers.length) {
          let relatedIdentifier = relatedIdentifiers[k++];
          if (relatedIdentifier !== null) {
            return relatedIdentifier;
          }
        }
        k = 0;
        j++;
      }
      j = 0;
      i++;
    }
    return undefined;
  };

  return {
    iterator() {
      return {
        next: () => {
          const value = findNext();
          return { value, done: value === undefined };
        },
      };
    },
  };
}

/*
      Computes the set of Identifiers reachable from this Identifier.

      Reachability is determined over the relationship graph (ie a graph where
      nodes are identifiers and edges are belongs to or has many
      relationships).

      Returns an array including `this` and all identifiers reachable
      from `this.identifier`.
    */
function _allRelatedIdentifiers(
  storeWrapper: CacheStoreWrapper,
  originating: StableRecordIdentifier
): StableRecordIdentifier[] {
  let array: StableRecordIdentifier[] = [];
  let queue: StableRecordIdentifier[] = [];
  let seen = new Set();
  queue.push(originating);
  while (queue.length > 0) {
    let identifier = queue.shift()!;
    array.push(identifier);
    seen.add(identifier);

    const iterator = _directlyRelatedIdentifiersIterable(storeWrapper, originating).iterator();
    for (let obj = iterator.next(); !obj.done; obj = iterator.next()) {
      const identifier = obj.value;
      if (identifier && !seen.has(identifier)) {
        seen.add(identifier);
        queue.push(identifier);
      }
    }
  }

  return array;
}