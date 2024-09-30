import { Field, SmartContract, state, State, method, Reducer } from 'o1js';

export class Add extends SmartContract {
  @state(Field) totalSum = State<Field>();
  @state(Field) lastProcessedActionState = State<Field>();

  reducer = Reducer({ actionType: Field });

  init() {
    super.init();
    this.lastProcessedActionState.set(Reducer.initialActionState);
  }

  @method async add(value: Field) {
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

  @method async customReduce() {}
}
