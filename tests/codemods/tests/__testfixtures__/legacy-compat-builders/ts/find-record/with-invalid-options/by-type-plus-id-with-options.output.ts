import { findRecord } from '@ember-data/legacy-compat/builders';
const { content: validPost } = await store.request(findRecord<Post>('post', '1'));
const invalidPost = await store.findRecord<Post>('post', '1', {
  preload: {},
});
