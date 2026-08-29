'use strict';

/** 永続化を行わない、プロセスメモリ内だけの状態コンテナ。 */
function createStore(initialState) {
  let state = initialState;
  const subscribers = new Set();

  function getState() {
    return state;
  }

  function setState(nextState) {
    const resolved = typeof nextState === 'function' ? nextState(state) : nextState;
    if (Object.is(resolved, state)) return state;
    const previous = state;
    state = resolved;
    for (const subscriber of [...subscribers]) subscriber(state, previous);
    return state;
  }

  function subscribe(subscriber) {
    if (typeof subscriber !== 'function') throw new TypeError('subscriberは関数で指定してください');
    subscribers.add(subscriber);
    return function unsubscribe() {
      subscribers.delete(subscriber);
    };
  }

  function clear(nextState = undefined) {
    return setState(nextState);
  }

  return Object.freeze({ getState, setState, subscribe, clear });
}

module.exports = Object.freeze({ createStore });
