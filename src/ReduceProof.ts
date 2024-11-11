import { Field, Poseidon, SelfProof, Struct, ZkProgram } from 'o1js';

// https://github.com/o1-labs/o1js-bindings/blob/71f2e698dadcdfc62c76a72248c0df71cfd39d4c/lib/binable.ts#L317
let encoder = new TextEncoder();

function stringToBytes(s: string) {
  return [...encoder.encode(s)];
}

function prefixToField<Field>(
  // Field: GenericSignableField<Field>,
  Field: any,
  prefix: string
) {
  let fieldSize = Field.sizeInBytes;
  if (prefix.length >= fieldSize) throw Error('prefix too long');
  let stringBytes = stringToBytes(prefix);
  return Field.fromBytes(
    stringBytes.concat(Array(fieldSize - stringBytes.length).fill(0))
  );
}

// hashing helpers taken from https://github.com/o1-labs/o1js/blob/72a2779c6728e80e0c9d1462020347c954a0ffb5/src/lib/mina/events.ts#L28
function initialState() {
  return [Field(0), Field(0), Field(0)] as [Field, Field, Field];
}
function salt(prefix: string) {
  return Poseidon.update(initialState(), [prefixToField(Field, prefix)]);
}
function hashWithPrefix(prefix: string, input: Field[]) {
  let init = salt(prefix);
  return Poseidon.update(init, input)[0];
}
function emptyHashWithPrefix(prefix: string) {
  return salt(prefix)[0];
}

export const actionListAdd = (hash: Field, action: Field): Field => {
  return Poseidon.hashWithPrefix('MinaZkappSeqEvents**', [
    hash,
    Poseidon.hashWithPrefix('MinaZkappEvent******', [action]),
  ]);
};
export const merkleActionsAdd = (hash: Field, actionsHash: Field): Field => {
  return Poseidon.hashWithPrefix('MinaZkappSeqEvents**', [hash, actionsHash]);
};

export class ReducePublicInput extends Struct({
  value: Field,
}) {}

export class ReducePublicOutput extends Struct({
  total: Field,
  initialSum: Field,
  initialActionState: Field,
  actionSubListState: Field,
  actionListState: Field,
}) {}

export const emptyActionListHash = emptyHashWithPrefix('MinaZkappActionsEmpty');

export async function init(
  input: ReducePublicInput,
  initialActionListState: Field
): Promise<{ publicOutput: ReducePublicOutput }> {
  return {
    publicOutput: new ReducePublicOutput({
      total: input.value,
      initialSum: input.value,
      initialActionState: initialActionListState,
      actionSubListState: emptyActionListHash,
      actionListState: initialActionListState,
    }),
  };
}

export async function add(
  input: ReducePublicInput,
  prevProof: SelfProof<ReducePublicInput, ReducePublicOutput>
): Promise<{ publicOutput: ReducePublicOutput }> {
  prevProof.verify();

  let newActionSubListState = actionListAdd(
    prevProof.publicOutput.actionSubListState,
    input.value
  );

  return {
    publicOutput: new ReducePublicOutput({
      total: prevProof.publicOutput.total.add(input.value),
      initialSum: prevProof.publicOutput.initialSum,
      initialActionState: prevProof.publicOutput.initialActionState,
      actionSubListState: newActionSubListState,
      actionListState: prevProof.publicOutput.actionListState,
    }),
  };
}

export async function cutActions(
  input: ReducePublicInput,
  prevProof: SelfProof<ReducePublicInput, ReducePublicOutput>
): Promise<{ publicOutput: ReducePublicOutput }> {
  return {
    publicOutput: new ReducePublicOutput({
      total: prevProof.publicOutput.total,
      initialSum: prevProof.publicOutput.initialSum,
      initialActionState: prevProof.publicOutput.initialActionState,
      actionSubListState: emptyActionListHash,
      actionListState: merkleActionsAdd(
        prevProof.publicOutput.actionListState,
        prevProof.publicOutput.actionSubListState
      ),
    }),
  };
}

export const ReduceProgram = ZkProgram({
  name: 'reduce-program',
  publicInput: ReducePublicInput,
  publicOutput: ReducePublicOutput,
  methods: {
    init: {
      privateInputs: [Field],
      async method(input: ReducePublicInput, initialActionListState: Field) {
        return init(input, initialActionListState);
      },
    },
    add: {
      privateInputs: [SelfProof],
      async method(
        input: ReducePublicInput,
        prevProof: SelfProof<ReducePublicInput, ReducePublicOutput>
      ) {
        return add(input, prevProof);
      },
    },
    cutActions: {
      privateInputs: [SelfProof],
      async method(
        input: ReducePublicInput,
        prevProof: SelfProof<ReducePublicInput, ReducePublicOutput>
      ) {
        return cutActions(input, prevProof);
      },
    },
  },
});

export class ReduceProof extends ZkProgram.Proof(ReduceProgram) {}
