/*
  @module @warp-drive/core-types
  @internal
*/

export type LegacyRelationshipSchema = {
  kind: 'belongsTo' | 'hasMany';
  type: string; // related type
  // TODO @runspired should RFC be updated to make this optional?
  // TODO @runspired sohuld RFC be update to enforce async and inverse are set? else internals need to know
  // that meta came from @ember-data/model vs not from @ember-data/model as defaults should switch.
  options: {
    as?: string; //for polymorphic relationships, what the abstract type this is satisfying is
    async: boolean; // controls inverse unloading "client side delete semantics" so we should replace that with a real flag
    polymorphic?: boolean;
    inverse: string | null; // property key on the related type (if any)
    resetOnRemoteUpdate?: false; // manages the deprecation `DEPRECATE_RELATIONSHIP_REMOTE_UPDATE_CLEARING_LOCAL_STATE`
    [key: string]: unknown;
  };
  // inverse?: string | null;
  // inverseIsAsync?: boolean;
  name: string; // property key for this relationship
};

export type CollectionSchema = {
  kind: 'collection';

  /**
   * The property key for this relationship.
   *
   * @typedoc
   */
  name: string;

  /**
   * The resource type we are related to, the abstract type
   * if we are polymorphic.
   *
   * @typedoc
   */
  type: string;
  /**
   * The options for this relationship.
   *
   * If omitted, the relationships is assumed to be
   *
   * - inverse: null
   * - polymorphic: false
   *
   * @typedoc
   */
  options?: {
    /**
     * If this relationship is the inverse of a polymorphic relationship, this
     * is the abstract type that this relationship is satisfying.
     *
     * e.g. If we are the inverse of the below relationship:
     *
     * ```ts
     * class Comment extends Model {
     *   @belongsTo('commentable', {
     *    inverse: 'comments',
     *    polymorphic: true,
     *    async: true
     *   })
     *   parent!: Commentable;
     * }
     * ```
     *
     * Then the correct definition for this `comments` relationship would be:
     *
     * ```ts
     * class Post extends Model {
     *   @collection('comment', {
     *     as: 'commentable',
     *     inverse: 'parent'
     *   })
     *   comments!: PaginatedCollection<Comment>;
     * }
     * ```
     *
     * Or in JSON
     *
     * ```json
     * {
     *   "kind": "collection",
     *   "type": "comment",
     *   "options": {
     *     "as": "commentable",
     *     "inverse": "parent"
     *   }
     * }
     * ```
     *
     * @typedoc
     */
    as?: string;
    /**
     * The property key on the related type(s) that this relationship
     * is the inverse of. Must be identical across all types that satisfy
     * the relationship.
     *
     * @typedoc
     */
    inverse: string;

    /**
     * Whether this relationship is polymorphic (accepts multiple resource types
     * as values)
     *
     * @typedoc
     */
    polymorphic?: boolean;
  };
};

export type RelationshipSchema = LegacyRelationshipSchema | CollectionSchema;

export type RelationshipsSchema = Record<string, RelationshipSchema>;

export interface AttributeSchema {
  name: string;
  kind: 'attribute';

  // TODO @runspired update RFC to make options optional
  options?: {
    [key: string]: unknown;
  };
  type: string | null;
}

export type AttributesSchema = Record<string, AttributeSchema>;
