import { query } from '@ember-data/legacy-compat/builders';
// NOTE: Ideally the comment order and positioning would be unchanged, but due to limitations in recast, this doesn't seem possible
// 1
const { content: post } = await store // 2
  // 3
  .request(
    query(
      // 4
      'post', // 5
      // 6
      {
        // 7
        id: '1', // 8
        // 9
      }, // 10
      // 11
      // 15
      // 16
      {
        // 12
        reload: true, // 13
        // 14
      }
    )
  ); // 17
// 18
