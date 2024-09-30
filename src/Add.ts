import { Field, SmartContract, state, State, method, Reducer } from 'o1js';

export class Add extends SmartContract {
  @state(Field) totalSum = State<Field>();

  reducer = Reducer({ actionType: Field });

  init() {
    super.init();
  }

  @method async add(value: Field) {
    this.reducer.dispatch(value);
  }

  @method async defaultReduce() {}

  @method async customReduce() {}
}
