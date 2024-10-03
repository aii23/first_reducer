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

export const emptyActionListHash = emptyHashWithPrefix('MinaZkappActionsEmpty');

export const actionListAdd = (hash: Field, action: Field): Field => {
  return Poseidon.hashWithPrefix('MinaZkappSeqEvents**', [
    hash,
    Poseidon.hashWithPrefix('MinaZkappEvent******', [action]),
  ]);
};
export const merkleActionsAdd = (hash: Field, actionsHash: Field): Field => {
  return Poseidon.hashWithPrefix('MinaZkappSeqEvents**', [hash, actionsHash]);
};

export const flatListAdd = (hash: Field, action: Field): Field => {
  return Poseidon.hashWithPrefix('OurFlatListPrefix***', [hash, action]);
};

export const emptyFlatListHash = emptyHashWithPrefix('OurFlatListEmpty');

export class FlatPublicInput extends Struct({
  value: Field,
}) {}

export class FlatPublicOutput extends Struct({
  initialActionState: Field,
  actionSubListState: Field,
  actionListState: Field,
  flatListState: Field,
}) {}

export async function flatInit(
  input: FlatPublicInput,
  initialActionListState: Field
): Promise<FlatPublicOutput> {
  return new FlatPublicOutput({
    initialActionState: initialActionListState,
    actionSubListState: emptyActionListHash,
    actionListState: initialActionListState,
    flatListState: emptyFlatListHash,
  });
}

export async function flatAdd(
  input: FlatPublicInput,
  prevProof: SelfProof<FlatPublicInput, FlatPublicOutput>
): Promise<FlatPublicOutput> {
  prevProof.verify();

  let newActionSubListState = actionListAdd(
    prevProof.publicOutput.actionSubListState,
    input.value
  );

  return new FlatPublicOutput({
    initialActionState: prevProof.publicOutput.initialActionState,
    actionSubListState: newActionSubListState,
    actionListState: prevProof.publicOutput.actionListState,
    flatListState: flatListAdd(
      prevProof.publicOutput.flatListState,
      input.value
    ),
  });
}

export async function flatCutActions(
  input: FlatPublicInput,
  prevProof: SelfProof<FlatPublicInput, FlatPublicOutput>
): Promise<FlatPublicOutput> {
  return new FlatPublicOutput({
    initialActionState: prevProof.publicOutput.initialActionState,
    actionSubListState: emptyActionListHash,
    actionListState: merkleActionsAdd(
      prevProof.publicOutput.actionListState,
      prevProof.publicOutput.actionSubListState
    ),
    flatListState: prevProof.publicOutput.flatListState,
  });
}

export const FlatProgram = ZkProgram({
  name: 'Flat-program',
  publicInput: FlatPublicInput,
  publicOutput: FlatPublicOutput,
  methods: {
    flatInit: {
      privateInputs: [Field],
      async method(
        input: FlatPublicInput,
        initialActionListState: Field
      ): Promise<FlatPublicOutput> {
        return flatInit(input, initialActionListState);
      },
    },
    flatAdd: {
      privateInputs: [SelfProof],
      async method(
        input: FlatPublicInput,
        prevProof: SelfProof<FlatPublicInput, FlatPublicOutput>
      ) {
        return flatAdd(input, prevProof);
      },
    },
    flatCutActions: {
      privateInputs: [SelfProof],
      async method(
        input: FlatPublicInput,
        prevProof: SelfProof<FlatPublicInput, FlatPublicOutput>
      ) {
        return flatCutActions(input, prevProof);
      },
    },
  },
});

export class FlatProof extends ZkProgram.Proof(FlatProgram) {}
