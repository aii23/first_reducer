import {
  Field,
  SmartContract,
  state,
  State,
  method,
  Reducer,
  Provable,
  Struct,
} from 'o1js';
import { ReduceProof } from './ReduceProof';
import { emptyFlatListHash, flatListAdd, FlatProof } from './FlatProof';

export const BATCH_SIZE = 5;

export class SnapshotElement extends Struct({
  snapshotTail: Field,
  action: Field,
}) {}

export class SnapshotElements extends Struct({
  value: Provable.Array(SnapshotElement, BATCH_SIZE),
}) {}

export class Add extends SmartContract {
  @state(Field) totalSum = State<Field>();
  @state(Field) lastProcessedActionState = State<Field>();

  reducer = Reducer({ actionType: Field });

  init() {
    super.init();
    this.lastProcessedActionState.set(Reducer.initialActionState);
  }

  @method async add(value: Field) {
    value.assertGreaterThan(Field(0));
    this.reducer.dispatch(value);
  }

  @method async defaultReduce() {
    const lastProcessedActionState =
      this.lastProcessedActionState.getAndRequireEquals();
    const totalSum = this.totalSum.getAndRequireEquals();
    const actions = this.reducer.getActions({
      fromActionState: lastProcessedActionState,
    });

    const newTotalSum = this.reducer.reduce(
      actions,
      Field,
      (state: Field, action: Field) => state.add(action),
      totalSum
    );

    this.totalSum.set(newTotalSum);
    this.lastProcessedActionState.set(actions.hash);
  }

  @method async customReduce(reduceProof: ReduceProof) {
    reduceProof.verify();

    const lastProcessedActionState =
      this.lastProcessedActionState.getAndRequireEquals();
    const totalSum = this.totalSum.getAndRequireEquals();

    // Proof inputs check
    reduceProof.publicOutput.initialActionState.assertEquals(
      lastProcessedActionState
    );
    reduceProof.publicOutput.initialSum.assertEquals(totalSum);

    this.account.actionState.requireEquals(
      reduceProof.publicOutput.actionListState
    );

    this.totalSum.set(reduceProof.publicOutput.total);
    this.lastProcessedActionState.set(reduceProof.publicOutput.actionListState);
  }

  @state(Field) snapshot = State<Field>();
  @state(Field) flattenSnapshot = State<Field>();

  @method async createSnapshot() {
    let snapshot = this.snapshot.getAndRequireEquals();
    snapshot.assertEquals(Field(0), 'Snapshot is already created');

    this.snapshot.set(this.account.actionState.getAndRequireEquals());
  }

  @method async flatSnapshot(flatProof: FlatProof) {
    let flattenSnapshot = this.flattenSnapshot.getAndRequireEquals();
    flattenSnapshot.assertEquals(Field(0), 'Snapshot is already flattened');

    flatProof.verify();

    const snapshot = this.snapshot.getAndRequireEquals();
    const lastProcessedActionState =
      this.lastProcessedActionState.getAndRequireEquals();

    flatProof.publicOutput.initialActionState.assertEquals(
      lastProcessedActionState
    );
    flatProof.publicOutput.actionListState.assertEquals(snapshot);

    this.flattenSnapshot.set(flatProof.publicOutput.flatListState);
  }

  @method async snapshotReduce(elements: SnapshotElements) {
    let snapshot = this.snapshot.getAndRequireEquals();
    let flattenSnapshot = this.flattenSnapshot.getAndRequireEquals();
    let total = this.totalSum.getAndRequireEquals();
    let lastProcessedActionState =
      this.lastProcessedActionState.getAndRequireEquals();

    for (let i = 0; i < BATCH_SIZE; i++) {
      let element = elements.value[i];
      let isDummy = element.action.equals(Field(0));

      // Check that element + tail is equal to snapshot
      let decomposeCheck = flatListAdd(
        element.snapshotTail,
        element.action
      ).equals(flattenSnapshot);
      decomposeCheck.or(isDummy).assertTrue();

      flattenSnapshot = Provable.if(
        isDummy,
        flattenSnapshot,
        element.snapshotTail
      );
      total = total.add(Provable.if(isDummy, Field(0), element.action));
    }

    let flattenSnapshotEnd = flattenSnapshot.equals(emptyFlatListHash);

    let newSnapshot = Provable.if(flattenSnapshotEnd, Field(0), snapshot);
    let newFlattenSnapshot = Provable.if(
      flattenSnapshotEnd,
      Field(0),
      flattenSnapshot
    );
    let newLastProcessedActionState = Provable.if(
      flattenSnapshotEnd,
      snapshot,
      lastProcessedActionState
    );

    this.lastProcessedActionState.set(newLastProcessedActionState);
    this.snapshot.set(newSnapshot);
    this.flattenSnapshot.set(newFlattenSnapshot);
    this.totalSum.set(total);
  }
}
