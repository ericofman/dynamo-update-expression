const jp = require('jsonpath')
const _ = require('lodash')

const due = require('./dynamo-update-expression')

const original = Object.freeze({
  id: 123,
  title: 'Bicycle 123',
  description: '123 description',
  bicycleType: 'Hybrid',
  brand: 'Brand-Company C',
  price: 500,
  color: ['Red', 'Black'], // String Set if you use docClient.createSet() before put/update
  productCategory: 'Bicycle',
  inStok: true,
  quantityOnHand: null,
  relatedItems: [341, 472, 649], // Numeric Set if you use docClient.createSet() before put/update
  pictures: {
    frontView: 'http://example.com/products/123_front.jpg',
    rearView: 'http://example.com/products/123_rear.jpg',
    sideView: 'http://example.com/products/123_left_side.jpg',
  },
  productReview: {
    fiveStar: ["Excellent! Can't recommend it highly enough! Buy it!", 'Do yourself a favor and buy this.'],
    oneStar: ['Terrible product! Do no buy this.'],
  },
  listOfAddresses: [
    {
      city: 'Tokyo',
      street: '123 Main St',
    },
    {
      city: 'Perth',
      street: '123 Front St',
    },
  ],
  comment: 'This product sells out quickly during the summer',
  'Safety.Warning': 'Always wear a helmet', // attribute name with `.`
})

describe('dynamodb-update-expression', () => {
  const ADDITIONS = {
    '$.root0': 'root0',
    '$.newParent.newChild1.newGrandChild1': 'c1gc1',
    '$.newParent.newChild1.newGrandChild2': 'c1gc',
    '$.newParent.newChild2.newGrandChild1': 'c2gc1',
    '$.newParent.newChild2.newGrandChild2': 'c2gc2',
    '$.newParent.newChild3': {},
    '$.pictures.otherSideView': 'pictures.otherSideView',
    '$.color[2]': 'Blue',
    '$.relatedItems[3]': 1000,
    '$.productReview.oneStar[1]': 'Never again!',
    '$["prefix-suffix"]': 'Value for attribute name with -',
    '$["name with space"]': 'name with spaces is also okay',
    '$["1atBeginning"]': 'name starting with number is also okay',
    '$.productReview.thisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesAndLimitAliasLen':
      'Value for attribute name with 255 characters excluding the parent path',
    '$.thisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesAndLimitAliasLen[0]':
      'Value for attribute name with 255 characters with subscript excluding the parent path',
  }

  const ADDITIONS_NO_ORPHANS = {
    '$.color[2]': 'Blue',
    '$.newParent': {
      newChild1: { newGrandChild1: 'c1gc1', newGrandChild2: 'c1gc' },
      newChild2: { newGrandChild1: 'c2gc1', newGrandChild2: 'c2gc2' },
      newChild3: {},
    },
    '$.pictures.otherSideView': 'pictures.otherSideView',
    '$.productReview.oneStar[1]': 'Never again!',
    '$.relatedItems[3]': 1000,
    '$.root0': 'root0',
    '$["prefix-suffix"]': 'Value for attribute name with -',
    '$["name with space"]': 'name with spaces is also okay',
    '$["1atBeginning"]': 'name starting with number is also okay',
    '$.productReview.thisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesAndLimitAliasLen':
      'Value for attribute name with 255 characters excluding the parent path',
    '$.thisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesAndLimitAliasLen': [
      'Value for attribute name with 255 characters with subscript excluding the parent path',
    ],
  }

  const UPDATES = {
    '$.title': 'root0',
    '$.pictures.rearView': 'root1.level1',
    '$.color[0]': 'Blue',
    '$.relatedItems[1]': 1000,
    '$.productReview.oneStar[0]': 'Never again!',
    '$["Safety.Warning"]': 'Value for attribute with DOT',
  }

  const DELETES = [
    '$.title',
    '$.pictures.rearView',
    '$.color[0]',
    '$.relatedItems[1]',
    // '$.productReview' // our delete diff paths enumerate leaves to preserve document structure allowing for subsequent queries with no null check on collections, and subsequent SET expressions without missing levels in the document
    '$.productReview.fiveStar[0]',
    '$.productReview.fiveStar[1]',
    '$.productReview.oneStar[0]',
  ]

  const applyUpdates = (document, updates) => {
    const modified = _.cloneDeep(document)
    // const modified = JSON.parse(JSON.stringify(document));
    for (const path in updates) {
      jp.value(modified, path, updates[path])
    }
    return modified
  }

  const applyDeletes = (document, deletes, nullify = true) => {
    const modified = _.cloneDeep(document)
    // const modified = JSON.parse(JSON.stringify(document));
    for (const path of deletes) {
      const parent = jp.parent(modified, path)
      if (_.isArray(parent)) {
        const _subscript = /\[([\d]+)\]$/
        const subscript = _subscript.exec(path)[1]
        if (nullify) {
          parent[subscript] = null // delete array['0'] doesn't work with jsonpath! list items should be deleted by setting to null or undefined,
        } else {
          parent.splice(subscript, 1)
        }
      } else {
        delete parent[path.split('.').pop()]
      }
    }
    return modified
  }

  describe('diff', () => {
    it('returns the diff objects with the ADD fields', () => {
      const modified = applyUpdates(original, ADDITIONS)

      const { ADD } = due.diff(original, modified, true)
      expect(
        ADD.reduce((acc, node) => {
          acc[node.stringPath] = node.value
          return acc
        }, {})
      ).toEqual(ADDITIONS)
    })

    it('returns the diff objects with the ADD fields with no orphans', () => {
      const modified = applyUpdates(original, ADDITIONS)

      const { ADD } = due.diff(original, modified, false)
      expect(
        ADD.reduce((acc, node) => {
          acc[node.stringPath] = node.value
          return acc
        }, {})
      ).toEqual(ADDITIONS_NO_ORPHANS)
    })

    it('returns the diff objects with the SET fields', () => {
      const modified = applyUpdates(original, UPDATES)

      const { SET } = due.diff(original, modified)
      expect(
        SET.reduce((acc, node) => {
          acc[node.stringPath] = node.value
          return acc
        }, {})
      ).toEqual(UPDATES)
    })

    it('returns the diff objects with the DELETE fields', () => {
      const modified = applyDeletes(original, DELETES)

      const { DELETE, SET, ADD } = due.diff(original, modified)
      expect(
        DELETE.reduce((acc, node) => {
          acc.push(node.stringPath)
          return acc
        }, []).sort()
      ).toEqual(DELETES.sort())
      expect(ADD).toEqual([])
      expect(SET).toEqual([])
    })
  })

  describe('getUpdateExpression', () => {
    it('showcase test case default usage', () => {
      const modified = {
        id: 123,
        // title: 'Bicycle 123', // DELETED
        description: '123 description',
        bicycleType: 'Hybrid',
        brand: 'Brand-Company C',
        price: 600, // UPDATED
        color: ['Red', undefined, 'Blue'], // ADDED color[2] = 'Blue', REMOVED color[1] by setting to undefined, never pop, see why it is best below
        productCategory: 'Bicycle',
        inStok: false, // UPDATED boolean true => false
        quantityOnHand: null, // No change, was null in original, still null. DynamoDB recognizes null.
        relatedItems: [100, null, 649], // UPDATE relatedItems[0], REMOVE relatedItems[1], always nullify or set to undefined, never pop
        pictures: {
          frontView: 'http://example.com/products/123_front.jpg',
          rearView: 'http://example.com/products/123_rear.jpg',
          sideView: 'http://example.com/products/123_right_side.jpg', // UPDATED Map item
          'left-view': 'http://example.com/products/123_left_side.jpg', // UPDATED Map item with dash
          'left-&-right-view': 'http://example.com/products/123_left_side.jpg', // UPDATED Map item with dash
        },
        productReview: {
          fiveStar: [
            '', // DynamoDB doesn't allow empty string, would be REMOVED
            'Do yourself a favor and buy this.',
            'This is new', // ADDED *deep* list item
          ],
          oneStar: [
            'Actually I take it back, it is alright', // UPDATED *deep* List item
          ],
        },
        comment: 'This product sells out quickly during the summer',
        'Safety.Warning': 'Always wear a helmet, ride at your own risk!', // UPDATED attribute name with `.`
      }
      const updateExpression = due.getUpdateExpression({ original, modified })
      expect(updateExpression).toEqual({
        UpdateExpression:
          'SET #color[2] = :color2, #pictures.#leftRightView = :picturesLeftRightView, #pictures.#leftView = :picturesLeftView, #productReview.#fiveStar[2] = :productReviewFiveStar2, #inStok = :inStok, #pictures.#sideView = :picturesSideView, #price = :price, #productReview.#oneStar[0] = :productReviewOneStar0, #relatedItems[0] = :relatedItems0, #safetyWarning = :safetyWarning REMOVE #color[1], #listOfAddresses, #productReview.#fiveStar[0], #relatedItems[1], #title',

        ExpressionAttributeNames: {
          '#color': 'color',
          '#fiveStar': 'fiveStar',
          '#inStok': 'inStok',
          '#leftRightView': 'left-&-right-view',
          '#leftView': 'left-view',
          '#listOfAddresses': 'listOfAddresses',
          '#oneStar': 'oneStar',
          '#pictures': 'pictures',
          '#price': 'price',
          '#productReview': 'productReview',
          '#relatedItems': 'relatedItems',
          '#safetyWarning': 'Safety.Warning',
          '#sideView': 'sideView',
          '#title': 'title',
        },
        ExpressionAttributeValues: {
          ':color2': 'Blue',
          ':inStok': false,
          ':picturesLeftRightView': 'http://example.com/products/123_left_side.jpg',
          ':picturesLeftView': 'http://example.com/products/123_left_side.jpg',
          ':picturesSideView': 'http://example.com/products/123_right_side.jpg',
          ':price': 600,
          ':productReviewFiveStar2': 'This is new',
          ':productReviewOneStar0': 'Actually I take it back, it is alright',
          ':relatedItems0': 100,
          ':safetyWarning': 'Always wear a helmet, ride at your own risk!',
        },
      })
    })

    it('showcase test case remove objects from array', () => {
      const modified = {
        id: 123,
        // title: 'Bicycle 123', // DELETED
        description: '123 description',
        bicycleType: 'Hybrid',
        brand: 'Brand-Company C',
        price: 600, // UPDATED
        color: ['Red', undefined, 'Blue'], // ADDED color[2] = 'Blue', REMOVED color[1] by setting to undefined, never pop, see why it is best below
        productCategory: 'Bicycle',
        inStok: false, // UPDATED boolean true => false
        quantityOnHand: null, // No change, was null in original, still null. DynamoDB recognizes null.
        relatedItems: [100, null, 649], // UPDATE relatedItems[0], REMOVE relatedItems[1], always nullify or set to undefined, never pop
        productReview: {
          fiveStar: [
            '', // DynamoDB doesn't allow empty string, would be REMOVED
            'Do yourself a favor and buy this.',
            'This is new', // ADDED *deep* list item
          ],
          oneStar: [
            'Actually I take it back, it is alright', // UPDATED *deep* List item
          ],
        },
        listOfAddresses: [
          {
            city: 'Tokyo',
            street: '123 Main St',
          },
        ],
        comment: 'This product sells out quickly during the summer',
        'Safety.Warning': 'Always wear a helmet, ride at your own risk!', // UPDATED attribute name with `.`
      }
      const updateExpression = due.getUpdateExpression({ original, modified })
      expect(updateExpression).toEqual({
        // UpdateExpression: 'SET #color[2] = :color2, #pictures.#leftRightView = :picturesLeftRightView, #pictures.#leftView = :picturesLeftView, #productReview.#fiveStar[2] = :productReviewFiveStar2, #inStok = :inStok, #pictures.#sideView = :picturesSideView, #price = :price, #productReview.#oneStar[0] = :productReviewOneStar0, #relatedItems[0] = :relatedItems0, #safetyWarning = :safetyWarning REMOVE #color[1], #productReview.#fiveStar[0], #relatedItems[1], #title',
        UpdateExpression:
          'SET #color[2] = :color2, #productReview.#fiveStar[2] = :productReviewFiveStar2, #inStok = :inStok, #price = :price, #productReview.#oneStar[0] = :productReviewOneStar0, #relatedItems[0] = :relatedItems0, #safetyWarning = :safetyWarning REMOVE #color[1], #listOfAddresses[1], #pictures, #productReview.#fiveStar[0], #relatedItems[1], #title',

        ExpressionAttributeNames: {
          '#color': 'color',
          '#fiveStar': 'fiveStar',
          '#inStok': 'inStok',
          '#listOfAddresses': 'listOfAddresses',
          '#oneStar': 'oneStar',
          '#pictures': 'pictures',
          '#price': 'price',
          '#productReview': 'productReview',
          '#relatedItems': 'relatedItems',
          '#safetyWarning': 'Safety.Warning',
          '#title': 'title',
        },
        ExpressionAttributeValues: {
          ':color2': 'Blue',
          ':inStok': false,
          ':price': 600,
          ':productReviewFiveStar2': 'This is new',
          ':productReviewOneStar0': 'Actually I take it back, it is alright',
          ':relatedItems0': 100,
          ':safetyWarning': 'Always wear a helmet, ride at your own risk!',
        },
      })
    })

    it('showcase test case remove partial objects from array', () => {
      const modified = {
        id: 123,
        // title: 'Bicycle 123', // DELETED
        description: '123 description',
        bicycleType: 'Hybrid',
        brand: 'Brand-Company C',
        price: 600, // UPDATED
        color: ['Red', undefined, 'Blue'], // ADDED color[2] = 'Blue', REMOVED color[1] by setting to undefined, never pop, see why it is best below
        productCategory: 'Bicycle',
        inStok: false, // UPDATED boolean true => false
        quantityOnHand: null, // No change, was null in original, still null. DynamoDB recognizes null.
        relatedItems: [100, null, 649], // UPDATE relatedItems[0], REMOVE relatedItems[1], always nullify or set to undefined, never pop
        pictures: {
          frontView: 'http://example.com/products/123_front.jpg',
          rearView: 'http://example.com/products/123_rear.jpg',
        },
        productReview: {
          fiveStar: [
            '', // DynamoDB doesn't allow empty string, would be REMOVED
            'Do yourself a favor and buy this.',
            'This is new', // ADDED *deep* list item
          ],
          oneStar: [
            'Actually I take it back, it is alright', // UPDATED *deep* List item
          ],
        },
        listOfAddresses: [
          {
            city: 'Tokyo',
            street: '123 Main St',
          },
          {
            city: 'Perth',
          },
        ],
        comment: 'This product sells out quickly during the summer',
        'Safety.Warning': 'Always wear a helmet, ride at your own risk!', // UPDATED attribute name with `.`
      }
      const updateExpression = due.getUpdateExpression({ original, modified })
      expect(updateExpression).toEqual({
        // UpdateExpression: 'SET #color[2] = :color2, #pictures.#leftRightView = :picturesLeftRightView, #pictures.#leftView = :picturesLeftView, #productReview.#fiveStar[2] = :productReviewFiveStar2, #inStok = :inStok, #pictures.#sideView = :picturesSideView, #price = :price, #productReview.#oneStar[0] = :productReviewOneStar0, #relatedItems[0] = :relatedItems0, #safetyWarning = :safetyWarning REMOVE #color[1], #productReview.#fiveStar[0], #relatedItems[1], #title',
        UpdateExpression:
          'SET #color[2] = :color2, #productReview.#fiveStar[2] = :productReviewFiveStar2, #inStok = :inStok, #price = :price, #productReview.#oneStar[0] = :productReviewOneStar0, #relatedItems[0] = :relatedItems0, #safetyWarning = :safetyWarning REMOVE #color[1], #listOfAddresses[1].#street, #pictures.#sideView, #productReview.#fiveStar[0], #relatedItems[1], #title',

        ExpressionAttributeNames: {
          '#color': 'color',
          '#fiveStar': 'fiveStar',
          '#inStok': 'inStok',
          '#listOfAddresses': 'listOfAddresses',
          '#oneStar': 'oneStar',
          '#pictures': 'pictures',
          '#price': 'price',
          '#productReview': 'productReview',
          '#relatedItems': 'relatedItems',
          '#safetyWarning': 'Safety.Warning',
          '#sideView': 'sideView',
          '#street': 'street',
          '#title': 'title',
        },
        ExpressionAttributeValues: {
          ':color2': 'Blue',
          ':inStok': false,
          ':price': 600,
          ':productReviewFiveStar2': 'This is new',
          ':productReviewOneStar0': 'Actually I take it back, it is alright',
          ':relatedItems0': 100,
          ':safetyWarning': 'Always wear a helmet, ride at your own risk!',
        },
      })
    })

    it('showcase test case orphans = false', () => {
      const partial = {
        id: 123,
        title: 'Bicycle 123',
        inStock: false,
        description: '123 description',
      }
      const modified = {
        id: 123,
        title: 'Bicycle 123',
        inStock: true,
        stock: 10,
        description: 'modified 123 description',
        pictures: {
          topView: 'http://example.com/products/123_top.jpg',
        },
      }

      const updateExpression = due.getUpdateExpression({
        original: partial,
        modified,
      })
      expect(updateExpression).toEqual({
        ExpressionAttributeNames: {
          '#description': 'description',
          '#inStock': 'inStock',
          '#pictures': 'pictures',
          '#stock': 'stock',
        },
        ExpressionAttributeValues: {
          ':description': 'modified 123 description',
          ':inStock': true,
          ':pictures': {
            topView: 'http://example.com/products/123_top.jpg',
          },
          ':stock': 10,
        },
        UpdateExpression:
          'SET #pictures = :pictures, #stock = :stock, #description = :description, #inStock = :inStock',
      })
    })

    it('showcase test case orphans = true', () => {
      const partial = {
        id: 123,
        title: 'Bicycle 123',
        inStock: false,
        description: '123 description',
      }
      const modified = {
        id: 123,
        title: 'Bicycle 123',
        inStock: true,
        stock: 10,
        description: 'modified 123 description',
        pictures: {
          topView: 'http://example.com/products/123_top.jpg',
        },
      }

      const updateExpression = due.getUpdateExpression({
        original: partial,
        modified,
        orphans: true,
      })
      expect(updateExpression).toEqual({
        ExpressionAttributeNames: {
          '#description': 'description',
          '#inStock': 'inStock',
          '#pictures': 'pictures',
          '#stock': 'stock',
          '#topView': 'topView',
        },
        ExpressionAttributeValues: {
          ':description': 'modified 123 description',
          ':inStock': true,
          ':picturesTopView': 'http://example.com/products/123_top.jpg',
          ':stock': 10,
        },
        UpdateExpression:
          'SET #pictures.#topView = :picturesTopView, #stock = :stock, #description = :description, #inStock = :inStock',
      })
    })

    it('showcase test case deep additions, orphans = false', () => {
      const partial = {
        id: 123,
        title: 'Bicycle 123',
        inStock: false,
        description: '123 description',
      }
      const modified = {
        id: 123,
        title: 'Bicycle 123',
        inStock: true,
        stock: 10,
        description: 'modified 123 description',
        productReview: {
          fiveStar: {
            comment: 'Such a fantastic item!',
          },
        },
      }

      const updateExpression = due.getUpdateExpression({
        original: partial,
        modified,
      })
      expect(updateExpression).toEqual({
        ExpressionAttributeNames: {
          '#description': 'description',
          '#inStock': 'inStock',
          '#productReview': 'productReview',
          '#stock': 'stock',
        },
        ExpressionAttributeValues: {
          ':description': 'modified 123 description',
          ':inStock': true,
          ':productReview': {
            fiveStar: {
              comment: 'Such a fantastic item!',
            },
          },
          ':stock': 10,
        },
        UpdateExpression:
          'SET #productReview = :productReview, #stock = :stock, #description = :description, #inStock = :inStock',
      })
    })

    it('showcase test case deep additions, orphans = true', () => {
      const partial = {
        id: 123,
        title: 'Bicycle 123',
        inStock: false,
        description: '123 description',
      }
      const modified = {
        id: 123,
        title: 'Bicycle 123',
        inStock: true,
        stock: 10,
        description: 'modified 123 description',
        productReview: {
          fiveStar: {
            comment: 'Such a fantastic item!',
          },
        },
      }

      const updateExpression = due.getUpdateExpression({
        original: partial,
        modified,
        orphans: true,
      })
      expect(updateExpression).toEqual({
        ExpressionAttributeNames: {
          '#comment': 'comment',
          '#description': 'description',
          '#fiveStar': 'fiveStar',
          '#inStock': 'inStock',
          '#productReview': 'productReview',
          '#stock': 'stock',
        },
        ExpressionAttributeValues: {
          ':description': 'modified 123 description',
          ':inStock': true,
          ':productReviewFiveStarComment': 'Such a fantastic item!',
          ':stock': 10,
        },
        UpdateExpression:
          'SET #productReview.#fiveStar.#comment = :productReviewFiveStarComment, #stock = :stock, #description = :description, #inStock = :inStock',
      })
    })

    it('creates update expression for ADDITIONS with orphans and long name truncation to 255', () => {
      const modified = applyUpdates(original, ADDITIONS)
      const updateExpression = due.getUpdateExpression({
        original,
        modified,
        orphans: true,
      })
      expect(updateExpression).toEqual({
        ExpressionAttributeNames: {
          '#1AtBeginning': '1atBeginning',
          '#color': 'color',
          '#nameWithSpace': 'name with space',
          '#newChild1': 'newChild1',
          '#newChild2': 'newChild2',
          '#newChild3': 'newChild3',
          '#newGrandChild1': 'newGrandChild1',
          '#newGrandChild2': 'newGrandChild2',
          '#newParent': 'newParent',
          '#oneStar': 'oneStar',
          '#otherSideView': 'otherSideView',
          '#pictures': 'pictures',
          '#prefixSuffix': 'prefix-suffix',
          '#productReview': 'productReview',
          '#relatedItems': 'relatedItems',
          '#root0': 'root0',
          '#thisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesAndLimitAliasL1':
            'thisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesAndLimitAliasLen',
          '#thisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesAndLimitAliasL3':
            'thisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesAndLimitAliasLen',
        },
        ExpressionAttributeValues: {
          ':1AtBeginning': 'name starting with number is also okay',
          ':color2': 'Blue',
          ':nameWithSpace': 'name with spaces is also okay',
          ':newParentNewChild1NewGrandChild1': 'c1gc1',
          ':newParentNewChild1NewGrandChild2': 'c1gc',
          ':newParentNewChild2NewGrandChild1': 'c2gc1',
          ':newParentNewChild2NewGrandChild2': 'c2gc2',
          ':newParentNewChild3': {},
          ':picturesOtherSideView': 'pictures.otherSideView',
          ':prefixSuffix': 'Value for attribute name with -',
          ':productReviewOneStar1': 'Never again!',
          ':productReviewThisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesA2':
            'Value for attribute name with 255 characters excluding the parent path',
          ':relatedItems3': 1000,
          ':root0': 'root0',
          ':thisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesAndLimitAliasL4':
            'Value for attribute name with 255 characters with subscript excluding the parent path',
        },
        UpdateExpression:
          'SET #color[2] = :color2, #newParent.#newChild1.#newGrandChild1 = :newParentNewChild1NewGrandChild1, #newParent.#newChild1.#newGrandChild2 = :newParentNewChild1NewGrandChild2, #newParent.#newChild2.#newGrandChild1 = :newParentNewChild2NewGrandChild1, #newParent.#newChild2.#newGrandChild2 = :newParentNewChild2NewGrandChild2, #newParent.#newChild3 = :newParentNewChild3, #pictures.#otherSideView = :picturesOtherSideView, #productReview.#oneStar[1] = :productReviewOneStar1, #productReview.#thisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesAndLimitAliasL1 = :productReviewThisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesA2, #relatedItems[3] = :relatedItems3, #root0 = :root0, #thisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesAndLimitAliasL3[0] = :thisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesAndLimitAliasL4, #1AtBeginning = :1AtBeginning, #nameWithSpace = :nameWithSpace, #prefixSuffix = :prefixSuffix',
      })
    })

    it('creates update expression for ADDITIONS with no orphans', () => {
      const modified = applyUpdates(original, ADDITIONS)
      const updateExpression = due.getUpdateExpression({ original, modified })
      expect(updateExpression).toEqual({
        ExpressionAttributeNames: {
          '#1AtBeginning': '1atBeginning',
          '#color': 'color',
          '#nameWithSpace': 'name with space',
          '#newParent': 'newParent',
          '#oneStar': 'oneStar',
          '#otherSideView': 'otherSideView',
          '#pictures': 'pictures',
          '#prefixSuffix': 'prefix-suffix',
          '#productReview': 'productReview',
          '#relatedItems': 'relatedItems',
          '#root0': 'root0',
          '#thisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesAndLimitAliasL1':
            'thisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesAndLimitAliasLen',
          '#thisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesAndLimitAliasL3':
            'thisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesAndLimitAliasLen',
        },
        ExpressionAttributeValues: {
          ':1AtBeginning': 'name starting with number is also okay',
          ':color2': 'Blue',
          ':nameWithSpace': 'name with spaces is also okay',
          ':newParent': {
            newChild1: {
              newGrandChild1: 'c1gc1',
              newGrandChild2: 'c1gc',
            },
            newChild2: {
              newGrandChild1: 'c2gc1',
              newGrandChild2: 'c2gc2',
            },
            newChild3: {},
          },
          ':picturesOtherSideView': 'pictures.otherSideView',
          ':prefixSuffix': 'Value for attribute name with -',
          ':productReviewOneStar1': 'Never again!',
          ':productReviewThisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesA2':
            'Value for attribute name with 255 characters excluding the parent path',
          ':relatedItems3': 1000,
          ':root0': 'root0',
          ':thisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesAndLimitAliasL4': [
            'Value for attribute name with 255 characters with subscript excluding the parent path',
          ],
        },
        UpdateExpression:
          'SET #color[2] = :color2, #newParent = :newParent, #pictures.#otherSideView = :picturesOtherSideView, #productReview.#oneStar[1] = :productReviewOneStar1, #productReview.#thisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesAndLimitAliasL1 = :productReviewThisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesA2, #relatedItems[3] = :relatedItems3, #root0 = :root0, #thisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesAndLimitAliasL3 = :thisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesAndLimitAliasL4, #1AtBeginning = :1AtBeginning, #nameWithSpace = :nameWithSpace, #prefixSuffix = :prefixSuffix',
      })
    })

    it('creates update expression for UPDATES', () => {
      const modified = applyUpdates(original, UPDATES)
      const updateExpression = due.getUpdateExpression({ original, modified })
      expect(updateExpression).toEqual({
        ExpressionAttributeNames: {
          '#color': 'color',
          '#oneStar': 'oneStar',
          '#pictures': 'pictures',
          '#productReview': 'productReview',
          '#rearView': 'rearView',
          '#relatedItems': 'relatedItems',
          '#safetyWarning': 'Safety.Warning',
          '#title': 'title',
        },
        ExpressionAttributeValues: {
          ':color0': 'Blue',
          ':picturesRearView': 'root1.level1',
          ':productReviewOneStar0': 'Never again!',
          ':relatedItems1': 1000,
          ':safetyWarning': 'Value for attribute with DOT',
          ':title': 'root0',
        },
        UpdateExpression:
          'SET #color[0] = :color0, #pictures.#rearView = :picturesRearView, #productReview.#oneStar[0] = :productReviewOneStar0, #relatedItems[1] = :relatedItems1, #title = :title, #safetyWarning = :safetyWarning',
      })
    })

    it('creates update expression using REMOVE for Map and List', () => {
      const modified = applyDeletes(original, DELETES)
      const updateExpression = due.getUpdateExpression({ original, modified })
      expect(updateExpression).toEqual({
        ExpressionAttributeNames: {
          '#color': 'color',
          '#fiveStar': 'fiveStar',
          '#oneStar': 'oneStar',
          '#pictures': 'pictures',
          '#productReview': 'productReview',
          '#rearView': 'rearView',
          '#relatedItems': 'relatedItems',
          '#title': 'title',
        },
        UpdateExpression:
          'REMOVE #color[0], #pictures.#rearView, #productReview.#fiveStar[0], #productReview.#fiveStar[1], #productReview.#oneStar[0], #relatedItems[1], #title',
      })
    })

    // it.skip('creates update expression using REMOVE Map and List, and DELETES for Set', () => {
    //     const modified = applyDeletes(original, DELETES);
    //     const updateExpression = due.getUpdateExpression({original, modified, orphans: true, supportSets: true});
    //     expect(updateExpression).toEqual({});
    // });

    it('creates update expression using SET & REMOVE for mixed add/update/delete document changes', () => {
      let modified = applyUpdates(original, ADDITIONS)
      modified = applyUpdates(modified, UPDATES)
      modified = applyDeletes(modified, DELETES)
      const updateExpression = due.getUpdateExpression({ original, modified })
      expect(updateExpression).toEqual({
        ExpressionAttributeNames: {
          '#1AtBeginning': '1atBeginning',
          '#color': 'color',
          '#fiveStar': 'fiveStar',
          '#nameWithSpace': 'name with space',
          '#newParent': 'newParent',
          '#oneStar': 'oneStar',
          '#otherSideView': 'otherSideView',
          '#pictures': 'pictures',
          '#prefixSuffix': 'prefix-suffix',
          '#productReview': 'productReview',
          '#rearView': 'rearView',
          '#relatedItems': 'relatedItems',
          '#root0': 'root0',
          '#safetyWarning': 'Safety.Warning',
          '#thisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesAndLimitAliasL1':
            'thisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesAndLimitAliasLen',
          '#thisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesAndLimitAliasL3':
            'thisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesAndLimitAliasLen',
          '#title': 'title',
        },
        ExpressionAttributeValues: {
          ':1AtBeginning': 'name starting with number is also okay',
          ':color2': 'Blue',
          ':nameWithSpace': 'name with spaces is also okay',
          ':newParent': {
            newChild1: {
              newGrandChild1: 'c1gc1',
              newGrandChild2: 'c1gc',
            },
            newChild2: {
              newGrandChild1: 'c2gc1',
              newGrandChild2: 'c2gc2',
            },
            newChild3: {},
          },
          ':picturesOtherSideView': 'pictures.otherSideView',
          ':prefixSuffix': 'Value for attribute name with -',
          ':productReviewOneStar1': 'Never again!',
          ':productReviewThisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesA2':
            'Value for attribute name with 255 characters excluding the parent path',
          ':relatedItems3': 1000,
          ':root0': 'root0',
          ':safetyWarning': 'Value for attribute with DOT',
          ':thisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesAndLimitAliasL4': [
            'Value for attribute name with 255 characters with subscript excluding the parent path',
          ],
        },
        UpdateExpression:
          'SET #color[2] = :color2, #newParent = :newParent, #pictures.#otherSideView = :picturesOtherSideView, #productReview.#oneStar[1] = :productReviewOneStar1, #productReview.#thisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesAndLimitAliasL1 = :productReviewThisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesA2, #relatedItems[3] = :relatedItems3, #root0 = :root0, #thisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesAndLimitAliasL3 = :thisIsAVeryLongAttributeNameAndHadToKeepTypingRandomWordsToTryToGetUpTo255CharactersYouWouldThinkThatThisIsEnoughOrThatItWillHappenOftenWhenYouHaveAnAttributeThatLongYouMightAlsoOpenAnIssueAboutItPleaseDoNotSinceTheLibraryDoesTrimYourNamesAndLimitAliasL4, #1AtBeginning = :1AtBeginning, #nameWithSpace = :nameWithSpace, #prefixSuffix = :prefixSuffix, #safetyWarning = :safetyWarning REMOVE #color[0], #pictures.#rearView, #productReview.#fiveStar[0], #productReview.#fiveStar[1], #productReview.#oneStar[0], #relatedItems[1], #title',
      })
    })

    // TODO: Ideally this would work
    // Workaround for now is to delete the quote object in the original value before comparing.
    it.skip('creates update expression using SET & REMOVE for large object differences', () => {
      let original = {
        quote: { priced: false },
      }

      let modified = {
        quote: {
          'technology-professional-liability-coverage': 1000000,
          'professional-liability-deductible-first-party': 1000,
          'professional-liability-deductible-third-party': 2500,
          'professional-liability-base-premium': 945,
          'legal-contract-discount': 0,
          'us-revenue-multiplier-pro-li': 472.5,
          'rate-class-multiplier': 0,
          'professional-liability-premium': 1417.5,
          'cyber-coverage': 250000,
          'cyber-deductible': 1000,
          'cyber-premium': 0,
          'network-security-and-privacy-breach-liability': 250000,
          'network-security-and-privacy-breach-deductible': 2500,
          'electronic-media-liability': 250000,
          'electronic-media-deductible': 2500,
          'privacy-breach-expense': 50000,
          'privacy-breach-expense-deductible': 1000,
          'information-asset-loss': 50000,
          'information-asset-loss-deductible': 1000,
          'business-interruption-loss': 50000,
          'business-interruption-loss-deductible': '24 Hours',
          'general-liability-coverage': 1000000,
          'general-liability-deductible': 1000,
          'general-liability-premium': 787.5,
          'tenants-legal-liability': 500000,
          'standard-non-owned-automobile-policy': 1000000,
          'employee-benefits-liability-policy-coverage': 1000000,
          'employers-liability': 1000000,
          'sef-94-legal-liability-for-damage-to-hired-auto': 50000,
          'contents-coverage': 50000,
          'contents-deductible': 1000,
          'contents-premium': 400,
          crime: 5000,
          'crime-deductible': 1000,
          flood: 'Included',
          'flood-deductible': 25000,
          earthquake: 'Included',
          'earthquake-deductible': '3% or minimum $25,000',
          'sewer-backup': 'Included',
          'sewer-backup-deductible': 2500,
          'equipment-breakdown': 'Included',
          'equipment-breakdown-deductible': 1000,
          'miscellaneous-property-floater': 5000,
          'miscellaneous-property-deductible': 1000,
          'business-interruption-coverage': 50000,
          'business-interruption-deductible': '24 Hours',
          'business-interruption-premium': 100,
          'intellectual-property-coverage': 0,
          'intellectual-property-deductible': 0,
          'intellectual-property-premium': 0,
          'policy-expiry-date': 'December 23, 2020',
          priced: true,
          propertyPremiumSum: 500,
          liabilityPremiumSum: 2205,
          premiumsSubTotal: 2705,
          premiumsTotalWtihTax: 2705,
          'your-annual-insurance-policy-quote': 2705,
          'taxes-&-fees': {
            annual: 227.35,
            monthly: 509.35,
          },
          total: {
            annual: 2932.35,
            monthly: 3214.44,
            monthlyPayment: 267.87,
          },
          retroDate: 'December 23, 2019',
          prov: 'bc',
          premiumsSum: 2705,
          insurerPremium: 2028.75,
          brokerPremium: 405.75,
          dmgaPremium: 270.5,
          premiumsTaxRate: 0,
          premiumsTaxes: 0,
          brokerTransfer: 405.75,
          premiumsTotal: 2705,
          saasFee: 135.25,
          saasFeeGST: 6.76,
          saasTotal: 142.01,
          preStripe: 2847.01,
          stripeFees: 85.34,
          monthlyStripeFees: 96.84,
          customFee: 0,
          customFeeTax: 0,
          customFeeTotal: 0,
          financingFees: 270.5,
        },
      }

      const updateExpression = due.getUpdateExpression({ original, modified })
      expect(updateExpression).toEqual({
        ExpressionAttributeNames: {
          '#quote': 'quote',
        },
        ExpressionAttributeValues: {
          ':quote': modified.quote,
        },
        UpdateExpression: 'SET #quote = :quote',
      })
    })

    it('does not create an update expression for empty objects or arrays', () => {
      let original = {
        quote: {},
        ineligibleFields: [],
      }

      let modified = {
        quote: {},
        ineligibleFields: [],
      }

      const updateExpression = due.getUpdateExpression({ original, modified })
      expect(updateExpression).toEqual({
        UpdateExpression: '',
      })
    })

    it('creates update expression correctly for deeply nested difference', () => {
      let original = {
        accountOwnerHistory: [
          {
            changes: [
              {
                field: 'marketplace',
                newValue: {
                  email: 'corey+noadmin@apollocover.com',
                  id: '46111395-154b-4913-93f6-a3b0377f2a30',
                  name: 'Corey Forrieter',
                  phoneNumber: '+17783874484',
                },
                previousValue: { isMarketplace: false },
              },
            ],
            comments: 'Temporary ownership change',
            serverTimestamp: '2020-11-04T20:54:59Z',
            userData: {
              userId: '6b122432-8da3-4339-9bbb-1fda0352b586',
              userName: 'Corey Forrieter',
            },
          },
          {
            changes: [
              {
                field: 'marketplace',
                newValue: {
                  email: 'corey+admin@apollocover.com',
                  id: '7afe4b94-efd3-4c5a-97c6-beb94328e9b3',
                  name: 'Corey Forrieter',
                  phoneNumber: '+17783874484',
                },
                previousValue: {
                  email: 'corey+noadmin@apollocover.com',
                  id: '46111395-154b-4913-93f6-a3b0377f2a30',
                  name: 'Corey Forrieter',
                  phoneNumber: '+17783874484',
                },
              },
            ],
            comments: 'Temporary ownership change',
            serverTimestamp: '2020-11-05T00:04:11Z',
            userData: {
              userId: '6b122432-8da3-4339-9bbb-1fda0352b586',
              userName: 'Corey Forrieter',
            },
          },
        ],
      }

      let modified = {
        accountOwnerHistory: [
          {
            changes: [
              {
                field: 'marketplace',
                newValue: {
                  email: 'corey+noadmin@apollocover.com',
                  id: '46111395-154b-4913-93f6-a3b0377f2a30',
                  name: 'Corey Forrieter',
                  phoneNumber: '+17783874484',
                },
                previousValue: { isMarketplace: true },
              },
            ],
            comments: 'Temporary ownership change',
            serverTimestamp: '2020-11-04T20:54:59Z',
            userData: {
              userId: '6b122432-8da3-4339-9bbb-1fda0352b586',
              userName: 'Corey Forrieter',
            },
          },
          {
            changes: [
              {
                field: 'marketplace',
                newValue: {
                  email: 'corey+admin@apollocover.com',
                  id: '7afe4b94-efd3-4c5a-97c6-beb94328e9b3',
                  name: 'Corey Forrieter',
                  phoneNumber: '+17783874484',
                },
                previousValue: {
                  email: 'corey+noadmin@apollocover.com',
                  id: '46111395-154b-4913-93f6-a3b0377f2a30',
                  name: 'Corey Forrieter',
                  phoneNumber: '+17783874484',
                },
              },
            ],
            comments: 'Temporary ownership change',
            serverTimestamp: '2020-11-05T00:04:11Z',
            userData: {
              userId: '6b122432-8da3-4339-9bbb-1fda0352b586',
              userName: 'Corey Forrieter',
            },
          },
        ],
      }
      const updateExpression = due.getUpdateExpression({ original, modified })
      expect(updateExpression).toEqual({
        ExpressionAttributeNames: {
          '#accountOwnerHistory': 'accountOwnerHistory',
          '#changes': 'changes',
          '#isMarketplace': 'isMarketplace',
          '#previousValue': 'previousValue',
        },
        ExpressionAttributeValues: {
          ':accountOwnerHistory0Changes0PreviousValueIsMarketplace': true,
        },
        UpdateExpression:
          'SET #accountOwnerHistory[0].#changes[0].#previousValue.#isMarketplace = :accountOwnerHistory0Changes0PreviousValueIsMarketplace',
      })
    })
  })

  describe('getVersionedUpdateExpression backward compatible versionning', () => {
    it('creates update expression for ADDITIONS with orphans with version = 1 if attribute_not_exists', () => {
      const original = {}
      const modified = { parent: { child: 'newChildValue' }, version: 1 }
      const updateExpression = due.getVersionedUpdateExpression({
        original,
        modified,
        orphans: true,
      })
      expect(updateExpression).toEqual({
        ConditionExpression: 'attribute_not_exists (#expectedVersion)',
        ExpressionAttributeNames: {
          '#child': 'child',
          '#expectedVersion': 'version',
          '#parent': 'parent',
          '#version': 'version',
        },
        ExpressionAttributeValues: {
          ':parentChild': 'newChildValue',
          ':version': 1,
        },
        UpdateExpression: 'SET #parent.#child = :parentChild, #version = :version',
      })
    })

    it('creates update expression for ADDITIONS with no orphans with version = 1 if attribute_not_exists', () => {
      const original = {}
      const modified = { parent: { child: 'newChildValue' }, version: 1 }
      const updateExpression = due.getVersionedUpdateExpression({
        original,
        modified,
        orphans: false,
      })
      expect(updateExpression).toEqual({
        ConditionExpression: 'attribute_not_exists (#expectedVersion)',
        ExpressionAttributeNames: {
          '#expectedVersion': 'version',
          '#parent': 'parent',
          '#version': 'version',
        },
        ExpressionAttributeValues: {
          ':parent': {
            child: 'newChildValue',
          },
          ':version': 1,
        },
        UpdateExpression: 'SET #parent = :parent, #version = :version',
      })
    })

    it('creates update expression for UPDATES with version = 1 if attribute_not_exists', () => {
      const original = { parent: { child: 'oldChildValue' } }
      const modified = { parent: { child: 'newChildValue' }, version: 1 }
      const updateExpression = due.getVersionedUpdateExpression({
        original,
        modified,
        orphans: false,
      })
      expect(updateExpression).toEqual({
        ConditionExpression: 'attribute_not_exists (#expectedVersion)',
        ExpressionAttributeNames: {
          '#child': 'child',
          '#expectedVersion': 'version',
          '#parent': 'parent',
          '#version': 'version',
        },
        ExpressionAttributeValues: {
          ':parentChild': 'newChildValue',
          ':version': 1,
        },
        UpdateExpression: 'SET #version = :version, #parent.#child = :parentChild',
      })
    })

    it('creates update expression using REMOVE for Map and List with version = 1 if attribute_not_exists', () => {
      const original = {
        parent: { child: 'oldChildValue' },
        childList: ['one', 'two'],
      }
      const modified = { parent: {}, childList: [null, 'two'], version: 1 }
      const updateExpression = due.getVersionedUpdateExpression({
        original,
        modified,
        orphans: false,
      })
      expect(updateExpression).toEqual({
        ConditionExpression: 'attribute_not_exists (#expectedVersion)',
        ExpressionAttributeNames: {
          '#child': 'child',
          '#childList': 'childList',
          '#expectedVersion': 'version',
          '#parent': 'parent',
          '#version': 'version',
        },
        ExpressionAttributeValues: {
          ':version': 1,
        },
        UpdateExpression: 'SET #version = :version REMOVE #childList[0], #parent.#child',
      })
    })

    it('creates update expression using SET & REMOVE for mixed add/update/delete document changes with version = 1 if attribute_not_exists', () => {
      const original = {
        parent: {
          child: 'oldChildValue',
          secondChild: 'secondChildValue',
        },
        childList: ['one', 'two'],
      }
      const modified = {
        parent: { child: 'newChildValue' },
        childList: [null, 'three'],
        version: 1,
      }
      const updateExpression = due.getVersionedUpdateExpression({
        original,
        modified,
        orphans: false,
      })
      expect(updateExpression).toEqual({
        ConditionExpression: 'attribute_not_exists (#expectedVersion)',
        ExpressionAttributeNames: {
          '#child': 'child',
          '#childList': 'childList',
          '#expectedVersion': 'version',
          '#parent': 'parent',
          '#secondChild': 'secondChild',
          '#version': 'version',
        },
        ExpressionAttributeValues: {
          ':childList1': 'three',
          ':parentChild': 'newChildValue',
          ':version': 1,
        },
        UpdateExpression:
          'SET #version = :version, #childList[1] = :childList1, #parent.#child = :parentChild REMOVE #childList[0], #parent.#secondChild',
      })
    })
  })

  describe('getVersionedUpdateExpression current version condition', () => {
    it('creates update expression for ADDITIONS with orphans with current version condition', () => {
      const original = { parent: { child: 'original value' }, version: 1 }
      const modified = { parent: { child: 'new value' }, version: 2 }
      const updateExpression = due.getVersionedUpdateExpression({
        original,
        modified,
        condition: '=',
      })
      expect(updateExpression).toEqual({
        ConditionExpression: '#expectedVersion = :expectedVersion',
        ExpressionAttributeNames: {
          '#child': 'child',
          '#expectedVersion': 'version',
          '#parent': 'parent',
          '#version': 'version',
        },
        ExpressionAttributeValues: {
          ':expectedVersion': 1,
          ':parentChild': 'new value',
          ':version': 2,
        },
        UpdateExpression: 'SET #parent.#child = :parentChild, #version = :version',
      })
    })

    it('creates update expression for ADDITIONS with no orphans with current version condition', () => {
      const original = { expiry: 500 }
      const modified = { parent: { child: 'newChildValue' }, expiry: 1000 }
      const updateExpression = due.getVersionedUpdateExpression({
        original,
        modified,
        versionPath: '$.expiry',
        orphans: false, // default
        useCurrent: true,
        condition: '<',
      })
      expect(updateExpression).toEqual({
        ConditionExpression: '#expectedExpiry < :expectedExpiry',
        ExpressionAttributeNames: {
          '#expectedExpiry': 'expiry',
          '#expiry': 'expiry',
          '#parent': 'parent',
        },
        ExpressionAttributeValues: {
          ':expectedExpiry': 500,
          ':expiry': 1000,
          ':parent': {
            child: 'newChildValue',
          },
        },
        UpdateExpression: 'SET #parent = :parent, #expiry = :expiry',
      })
    })

    it('creates update expression for UPDATES with current version condition', () => {
      const original = { parent: { child: { name: 'oldChildValue', age: 0 } } }
      const modified = {
        parent: { child: { name: 'newChildValue', age: 10 } },
      }
      const updateExpression = due.getVersionedUpdateExpression({
        original,
        modified,
        versionPath: '$.parent.child.age',
        useCurrent: true,
        aliasContext: { prefix: 'InvalidValue' },
        condition: '<=',
      })
      expect(updateExpression).toEqual({
        ConditionExpression: '#invalidValueParent.#invalidValueChild.#invalidValueAge <= :invalidValueParentChildAge',
        ExpressionAttributeNames: {
          '#age': 'age',
          '#child': 'child',
          '#invalidValueAge': 'age',
          '#invalidValueChild': 'child',
          '#invalidValueParent': 'parent',
          '#name': 'name',
          '#parent': 'parent',
        },
        ExpressionAttributeValues: {
          ':invalidValueParentChildAge': 0,
          ':parentChildAge': 10,
          ':parentChildName': 'newChildValue',
        },
        UpdateExpression: 'SET #parent.#child.#age = :parentChildAge, #parent.#child.#name = :parentChildName',
      })
    })

    it('creates update expression using REMOVE for Map and List with current version condition', () => {
      const original = {
        parent: { child: 'oldChildValue', childList: ['one', 'two'] },
        consumed: 100,
      }
      const modified = { parent: { childList: [null, 'two'] }, consumed: 0 }
      const updateExpression = due.getVersionedUpdateExpression({
        original,
        modified,
        versionPath: '$.consumed',
        useCurrent: true,
        aliasContext: { prefix: '' },
        condition: '>=',
      })
      expect(updateExpression).toEqual({
        ConditionExpression: '#consumed >= :consumed',
        ExpressionAttributeNames: {
          '#child': 'child',
          '#childList': 'childList',
          '#consumed': 'consumed',
          '#parent': 'parent',
        },
        ExpressionAttributeValues: {
          ':consumed': 100,
        },
        UpdateExpression: 'SET #consumed = :consumed REMOVE #parent.#child, #parent.#childList[0]',
      })
    })

    it('creates update expression using SET & REMOVE for mixed add/update/delete document changes with with current version condition', () => {
      const original = {
        v: 1,
        parent: {
          child: 'oldChildValue',
          childList: ['one', 'two'],
          secondChild: 'secondChildValue',
        },
      }
      const modified = {
        parent: { child: 'newChildValue', childList: [null, undefined] },
        v: 5,
      }
      const updateExpression = due.getVersionedUpdateExpression({
        original,
        modified,
        versionPath: '$.v',
        useCurrent: true,
        aliasContext: { prefix: '' },
        condition: '=',
      })
      expect(updateExpression).toEqual({
        ConditionExpression: '#v = :v',
        ExpressionAttributeNames: {
          '#child': 'child',
          '#childList': 'childList',
          '#parent': 'parent',
          '#secondChild': 'secondChild',
          '#v': 'v',
        },
        ExpressionAttributeValues: {
          ':parentChild': 'newChildValue',
          ':v': 1,
        },
        UpdateExpression:
          'SET #parent.#child = :parentChild, #v = :v REMOVE #parent.#childList[0], #parent.#childList[1], #parent.#secondChild',
      })
    })
  })

  describe('getVersionedUpdateExpression new version condition', () => {
    it('creates update expression for ADDITIONS with orphans with new version condition', () => {
      const modified = { coupon: { code: 'HG74XSD' }, price: 10 }
      const updateExpression = due.getVersionedUpdateExpression({
        modified,
        versionPath: '$.coupon.code',
        orphans: true,
        aliasContext: { prefix: '' },
      })

      expect(updateExpression).toEqual({
        ConditionExpression: 'attribute_not_exists (#coupon.#code)',
        ExpressionAttributeNames: {
          '#code': 'code',
          '#coupon': 'coupon',
          '#price': 'price',
        },
        ExpressionAttributeValues: {
          ':couponCode': 'HG74XSD',
          ':price': 10,
        },
        UpdateExpression: 'SET #coupon.#code = :couponCode, #price = :price',
      })
    })

    it('creates update expression for ADDITIONS with orphans with new version condition, overriding currentVersion value', () => {
      const modified = { coupon: { code: 'HG74XSD' }, price: 10 }
      const updateExpression = due.getVersionedUpdateExpression({
        modified,
        versionPath: '$.coupon.code',
        orphans: true,
        useCurrent: false,
        currentVersion: 'N/A',
        condition: '<>',
      })

      expect(updateExpression).toEqual({
        ConditionExpression: '#expectedCoupon.#expectedCode <> :expectedCouponCode',
        ExpressionAttributeNames: {
          '#code': 'code',
          '#coupon': 'coupon',
          '#expectedCode': 'code',
          '#expectedCoupon': 'coupon',
          '#price': 'price',
        },
        ExpressionAttributeValues: {
          ':couponCode': 'HG74XSD',
          ':expectedCouponCode': 'HG74XSD',
          ':price': 10,
        },
        UpdateExpression: 'SET #coupon.#code = :couponCode, #price = :price',
      })
    })

    it('creates update expression for ADDITIONS with no orphans with new version condition', () => {
      const original = { expiry: 500 }
      const modified = { parent: { child: 'newChildValue' }, expiry: 1000 }
      const updateExpression = due.getVersionedUpdateExpression({
        original,
        modified,
        versionPath: '$.expiry',
        orphans: false, // default
        useCurrent: false,
        condition: '<=',
      })
      expect(updateExpression).toEqual({
        ConditionExpression: '#expectedExpiry <= :expectedExpiry',
        ExpressionAttributeNames: {
          '#expectedExpiry': 'expiry',
          '#expiry': 'expiry',
          '#parent': 'parent',
        },
        ExpressionAttributeValues: {
          ':expectedExpiry': 1000,
          ':expiry': 1000,
          ':parent': {
            child: 'newChildValue',
          },
        },
        UpdateExpression: 'SET #parent = :parent, #expiry = :expiry',
      })
    })

    it('creates update expression for UPDATES with new version condition', () => {
      const original = { parent: { child: { name: 'oldChildValue', age: 0 } } }
      const modified = {
        parent: { child: { name: 'newChildValue', age: 10 } },
      }
      const updateExpression = due.getVersionedUpdateExpression({
        original,
        modified,
        versionPath: '$.parent.child.age',
        useCurrent: false,
        aliasContext: { prefix: 'InvalidValue' },
        condition: '<=',
      })
      expect(updateExpression).toEqual({
        ConditionExpression: '#invalidValueParent.#invalidValueChild.#invalidValueAge <= :invalidValueParentChildAge',
        ExpressionAttributeNames: {
          '#age': 'age',
          '#child': 'child',
          '#invalidValueAge': 'age',
          '#invalidValueChild': 'child',
          '#invalidValueParent': 'parent',
          '#name': 'name',
          '#parent': 'parent',
        },
        ExpressionAttributeValues: {
          ':invalidValueParentChildAge': 10,
          ':parentChildAge': 10,
          ':parentChildName': 'newChildValue',
        },
        UpdateExpression: 'SET #parent.#child.#age = :parentChildAge, #parent.#child.#name = :parentChildName',
      })
    })

    it('creates update expression using REMOVE for Map and List with new version condition', () => {
      const original = {
        parent: { child: 'oldChildValue', childList: ['one', 'two'] },
        consumed: 100,
      }
      const modified = { parent: { childList: [null, 'two'] }, consumed: 0 }
      const updateExpression = due.getVersionedUpdateExpression({
        original,
        modified,
        versionPath: '$.consumed',
        useCurrent: false,
        aliasContext: { prefix: '' },
        condition: '>=',
      })
      expect(updateExpression).toEqual({
        ConditionExpression: '#consumed >= :consumed',
        ExpressionAttributeNames: {
          '#child': 'child',
          '#childList': 'childList',
          '#consumed': 'consumed',
          '#parent': 'parent',
        },
        ExpressionAttributeValues: {
          ':consumed': 0,
        },
        UpdateExpression: 'SET #consumed = :consumed REMOVE #parent.#child, #parent.#childList[0]',
      })
    })

    it('creates update expression using SET & REMOVE for mixed add/update/delete document changes with with new version condition', () => {
      const original = {
        v: 1,
        parent: {
          child: 'oldChildValue',
          childList: ['one', 'two'],
          secondChild: 'secondChildValue',
        },
      }
      const modified = {
        parent: { child: 'newChildValue', childList: [null, undefined] },
        v: 5,
      }
      const updateExpression = due.getVersionedUpdateExpression({
        original,
        modified,
        versionPath: '$.v',
        useCurrent: false,
        aliasContext: { prefix: '' },
        condition: '<',
      })
      expect(updateExpression).toEqual({
        ConditionExpression: '#v < :v',
        ExpressionAttributeNames: {
          '#child': 'child',
          '#childList': 'childList',
          '#parent': 'parent',
          '#secondChild': 'secondChild',
          '#v': 'v',
        },
        ExpressionAttributeValues: {
          ':parentChild': 'newChildValue',
          ':v': 5,
        },
        UpdateExpression:
          'SET #parent.#child = :parentChild, #v = :v REMOVE #parent.#childList[0], #parent.#childList[1], #parent.#secondChild',
      })
    })

    it('creates conditional update expression for try-range-lock with new version value with custom condition on current range-value', () => {
      const partial = { expiry: 1499758452832 } // now
      const modified = { expiry: 1499762052832 } // now + 5 min
      const updateExpression = due.getVersionedUpdateExpression({
        original: partial,
        modified,
        versionPath: '$.expiry',
        condition: '<',
      })
      expect(updateExpression).toEqual({
        ConditionExpression: '#expectedExpiry < :expectedExpiry',
        ExpressionAttributeNames: {
          '#expectedExpiry': 'expiry',
          '#expiry': 'expiry',
        },
        ExpressionAttributeValues: {
          ':expectedExpiry': 1499758452832,
          ':expiry': 1499762052832,
        },
        UpdateExpression: 'SET #expiry = :expiry',
      })
    })
  })

  describe('getVersionLockExpression auto versionning', () => {
    it('creates conditional update expression for version-lock with auto version = 1 with backward compatibility check: if attribute_not_exists', () => {
      const updateExpression = due.getVersionLockExpression({})
      expect(updateExpression).toEqual({
        ConditionExpression: 'attribute_not_exists (#expectedVersion)',
        ExpressionAttributeNames: {
          '#expectedVersion': 'version',
          '#version': 'version',
        },
        ExpressionAttributeValues: {
          ':version': 1,
        },
        UpdateExpression: 'SET #version = :version',
      })
    })

    it('creates conditional update expression for version-lock with auto version = 1 with backward compatibility check: if attribute_not_exists', () => {
      const updateExpression = due.getVersionLockExpression({ original: {} })
      expect(updateExpression).toEqual({
        ConditionExpression: 'attribute_not_exists (#expectedVersion)',
        ExpressionAttributeNames: {
          '#expectedVersion': 'version',
          '#version': 'version',
        },
        ExpressionAttributeValues: {
          ':version': 1,
        },
        UpdateExpression: 'SET #version = :version',
      })
    })

    it('throws if auto-versioning is not possible for the current-version value', () => {
      expect(() => due.getVersionLockExpression({ original: { version: 'sometext' } })).toThrow(/Invalid arguments/)
    })

    it('creates conditional update expression for range-lock with new version value with custom condition on current range-value', () => {
      const newStart = 1000
      const updateExpression = due.getVersionLockExpression({
        versionPath: '$.start',
        newVersion: newStart,
        condition: '<',
      })
      expect(updateExpression).toEqual({
        ConditionExpression: '#expectedStart < :expectedStart',
        ExpressionAttributeNames: {
          '#expectedStart': 'start',
          '#start': 'start',
        },
        ExpressionAttributeValues: {
          ':expectedStart': 1000,
          ':start': 1000,
        },
        UpdateExpression: 'SET #start = :start',
      })
    })

    it('creates conditional update expression for version-lock with new version value with custom condition', () => {
      const expiryTimeStamp = 1499762052832
      const updateExpression = due.getVersionLockExpression({
        newVersion: expiryTimeStamp,
        condition: '<',
      })
      expect(updateExpression).toEqual({
        ConditionExpression: '#expectedVersion < :expectedVersion',
        ExpressionAttributeNames: {
          '#expectedVersion': 'version',
          '#version': 'version',
        },
        ExpressionAttributeValues: {
          ':expectedVersion': expiryTimeStamp,
          ':version': expiryTimeStamp,
        },
        UpdateExpression: 'SET #version = :version',
      })
    })

    it('creates conditional update expression for version-lock with new version auto-incremented value ', () => {
      const original = { version: 1 }
      const updateExpression = due.getVersionLockExpression({
        original,
        condition: '=',
      })
      expect(updateExpression).toEqual({
        ConditionExpression: '#expectedVersion = :expectedVersion',
        ExpressionAttributeNames: {
          '#expectedVersion': 'version',
          '#version': 'version',
        },
        ExpressionAttributeValues: { ':expectedVersion': 1, ':version': 2 },
        UpdateExpression: 'SET #version = :version',
      })
    })
  })
})
