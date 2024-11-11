import {
  AccountUpdate,
  Field,
  MerkleList,
  Mina,
  PrivateKey,
  PublicKey,
  Reducer,
} from 'o1js';
import { Add, BATCH_SIZE, SnapshotElement, SnapshotElements } from './Add';
import { Pickles } from 'o1js/dist/node/snarky';
import { dummyBase64Proof } from 'o1js/dist/node/lib/proof-system/zkprogram';
import {
  add,
  cutActions,
  init,
  ReduceProgram,
  ReduceProof,
  ReducePublicInput,
} from './ReduceProof';
import { Actions } from 'o1js/dist/node/bindings/mina-transaction/transaction-leaves';
import {
  emptyFlatListHash,
  flatAdd,
  flatCutActions,
  flatInit,
  flatListAdd,
  FlatProof,
  FlatPublicInput,
} from './FlatProof';

export async function mockProof<I, O, P>(
  publicOutput: O,
  ProofType: new ({
    proof,
    publicInput,
    publicOutput,
    maxProofsVerified,
  }: {
    proof: unknown;
    publicInput: I;
    publicOutput: any;
    maxProofsVerified: 0 | 2 | 1;
  }) => P,
  publicInput: I
): Promise<P> {
  const [, proof] = Pickles.proofOfBase64(await dummyBase64Proof(), 2);
  return new ProofType({
    proof: proof,
    maxProofsVerified: 2,
    publicInput,
    publicOutput,
  });
}

let proofsEnabled = false;

describe('Add', () => {
  let deployerAccount: Mina.TestPublicKey,
    deployerKey: PrivateKey,
    senderAccount: Mina.TestPublicKey,
    senderKey: PrivateKey,
    others: Mina.TestPublicKey[],
    zkAppAddress: PublicKey,
    zkAppPrivateKey: PrivateKey,
    zkApp: Add,
    doTest: (reduceFunction: () => Promise<void>) => Promise<void>;

  beforeAll(async () => {
    if (proofsEnabled) await Add.compile();
  });

  beforeEach(async () => {
    const Local = await Mina.LocalBlockchain({ proofsEnabled });
    Mina.setActiveInstance(Local);
    [deployerAccount, senderAccount, ...others] = Local.testAccounts;
    deployerKey = deployerAccount.key;
    senderKey = senderAccount.key;

    zkAppPrivateKey = PrivateKey.random();
    zkAppAddress = zkAppPrivateKey.toPublicKey();
    zkApp = new Add(zkAppAddress);

    doTest = async (reduce: () => Promise<void>) => {
      await localDeploy();

      let expectedTotal = Field(0);

      // Dispatch all actions
      for (let i = 0; i < 5; i++) {
        let value = Field(i + 1);
        let sender = others[i];
        let tx = await Mina.transaction(sender, async () => {
          await zkApp.add(value);
        });

        await tx.prove();
        await tx.sign([sender.key]).send();

        expectedTotal = expectedTotal.add(value);
      }

      let curTotalSum = zkApp.totalSum.get();
      expect(curTotalSum).toEqual(Field(0));

      // Reduce
      await reduce();

      let finalTotalSum = zkApp.totalSum.get();
      expect(finalTotalSum).toEqual(expectedTotal);

      // Do reduce second time, so we can check, that actions processed only once
      await reduce();

      finalTotalSum = zkApp.totalSum.get();
      expect(finalTotalSum).toEqual(expectedTotal);

      // Dispatch more actions
      for (let i = 0; i < 5; i++) {
        let value = Field(i + 1);
        let sender = others[i];
        let tx = await Mina.transaction(sender, async () => {
          await zkApp.add(value);
        });

        await tx.prove();
        await tx.sign([sender.key]).send();

        expectedTotal = expectedTotal.add(value);
      }

      await reduce();

      finalTotalSum = zkApp.totalSum.get();
      expect(finalTotalSum).toEqual(expectedTotal);

      console.log(`totalSum after final dispatch: ${finalTotalSum}`);
    };
  });

  async function localDeploy() {
    const txn = await Mina.transaction(deployerAccount, async () => {
      AccountUpdate.fundNewAccount(deployerAccount);
      await zkApp.deploy();
    });
    await txn.prove();
    // this tx needs .sign(), because `deploy()` adds an account update that requires signature authorization
    await txn.sign([deployerKey, zkAppPrivateKey]).send();
  }

  it('generates and deploys the `Add` smart contract', async () => {
    await localDeploy();
    const num = zkApp.totalSum.get();
    expect(num).toEqual(Field(0));
  });

  it('correctly updates the totalSum with default reducer', async () => {
    const defaultReduce = async () => {
      let tx = await Mina.transaction(senderAccount, async () => {
        await zkApp.defaultReduce();
      });

      await tx.prove();
      await tx.sign([senderAccount.key]).send();
    };

    await doTest(defaultReduce);
  });

  it('correctly updates the totalSum with custom reducer', async () => {
    const callCustomReduce = async () => {
      let curLatestProcessedState = zkApp.lastProcessedActionState.get();

      let actions = await zkApp.reducer.fetchActions({
        fromActionState: curLatestProcessedState,
      });

      let initPublicInput = new ReducePublicInput({
        value: zkApp.totalSum.get(),
      });

      let initPublicOutput = (
        await init(initPublicInput, curLatestProcessedState)
      ).publicOutput;

      let curProof = await mockProof(
        initPublicOutput,
        ReduceProof,
        initPublicInput
      );

      for (let i = 0; i < actions.length; i++) {
        for (let j = 0; j < actions[i].length; j++) {
          let action = actions[i][j];

          let publicInput = new ReducePublicInput({
            value: action,
          });

          let publicOutput = (await add(publicInput, curProof)).publicOutput;

          curProof = await mockProof(publicOutput, ReduceProof, publicInput);
        }

        let cutPublicInput = new ReducePublicInput({
          value: Field(0), // Unused
        });

        let cutPublicOutput = (await cutActions(cutPublicInput, curProof))
          .publicOutput;

        curProof = await mockProof(
          cutPublicOutput,
          ReduceProof,
          cutPublicInput
        );
      }

      let tx = await Mina.transaction(senderAccount, async () => {
        await zkApp.customReduce(curProof);
      });

      await tx.prove();
      await tx.sign([senderAccount.key]).send();
    };

    await doTest(callCustomReduce);
  });

  it('Snapshot reducer works', async () => {
    const snapshotFlattenAndReduce = async () => {
      let tx1 = await Mina.transaction(senderAccount, async () => {
        await zkApp.createSnapshot();
      });

      await tx1.prove();
      await tx1.sign([senderAccount.key]).send();

      let FlatActions = MerkleList.create(
        Field,
        flatListAdd,
        emptyFlatListHash
      );

      let flatActions = FlatActions.empty();

      let curLatestProcessedState = zkApp.lastProcessedActionState.get();

      let actions = await zkApp.reducer.fetchActions({
        fromActionState: curLatestProcessedState,
      });

      let initPublicInput = new FlatPublicInput({
        value: zkApp.totalSum.get(),
      });

      let initPublicOutput = (
        await flatInit(initPublicInput, curLatestProcessedState)
      ).publicOutput;

      let curProof = await mockProof(
        initPublicOutput,
        FlatProof,
        initPublicInput
      );

      for (let i = 0; i < actions.length; i++) {
        for (let j = 0; j < actions[i].length; j++) {
          let action = actions[i][j];

          let publicInput = new FlatPublicInput({
            value: action,
          });

          let publicOutput = (await flatAdd(publicInput, curProof))
            .publicOutput;

          curProof = await mockProof(publicOutput, FlatProof, publicInput);

          flatActions.push(action); // Push action to flatActions list
        }

        let cutPublicInput = new FlatPublicInput({
          value: Field(0), // Unused
        });

        let cutPublicOutput = (await flatCutActions(cutPublicInput, curProof))
          .publicOutput;

        curProof = await mockProof(cutPublicOutput, FlatProof, cutPublicInput);
      }

      let tx2 = await Mina.transaction(senderAccount, async () => {
        await zkApp.flatSnapshot(curProof);
      });

      await tx2.prove();
      await tx2.sign([senderAccount.key]).send();

      let allActionsIsReduced = false;

      while (!allActionsIsReduced) {
        let curBatch = [];
        for (let i = 0; i < BATCH_SIZE; i++) {
          if (!flatActions.isEmpty().toBoolean()) {
            let curAction = flatActions.pop();

            curBatch.push(
              //@ts-ignore
              new SnapshotElement({
                snapshotTail: flatActions.hash,
                action: curAction,
              })
            );
          } else {
            // Push dummy element
            curBatch.push(
              new SnapshotElement({
                snapshotTail: Field(0),
                action: Field(0),
              })
            );
          }
        }

        if (flatActions.isEmpty().toBoolean()) {
          allActionsIsReduced = true;
        }

        let txn = await Mina.transaction(senderAccount, async () => {
          await zkApp.snapshotReduce(
            new SnapshotElements({
              value: curBatch,
            })
          );
        });

        await txn.prove();
        await txn.sign([senderAccount.key]).send();
      }
    };

    await doTest(snapshotFlattenAndReduce);
  });
});
