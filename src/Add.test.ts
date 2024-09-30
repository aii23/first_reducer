import {
  AccountUpdate,
  Field,
  Mina,
  PrivateKey,
  PublicKey,
  Reducer,
} from 'o1js';
import { Add } from './Add';
import { Pickles } from 'o1js/dist/node/snarky';
import { dummyBase64Proof } from 'o1js/dist/node/lib/proof-system/zkprogram';
import {
  add,
  cutActions,
  init,
  ReduceProof,
  ReducePublicInput,
} from './ReduceProof';
import { Actions } from 'o1js/dist/node/bindings/mina-transaction/transaction-leaves';

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
    zkApp: Add;

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
    await localDeploy();

    let expectedTotal = Field(0);

    // Dispatch all actions
    for (let i = 0; i < 5; i++) {
      let sender = others[i];
      let tx = await Mina.transaction(sender, async () => {
        await zkApp.add(Field(i));
      });

      await tx.prove();
      await tx.sign([sender.key]).send();

      expectedTotal = expectedTotal.add(Field(i));
    }

    let curTotalSum = zkApp.totalSum.get();
    expect(curTotalSum).toEqual(Field(0));
    console.log(`Initial totalSum: ${curTotalSum}`);

    // Reduce
    let tx = await Mina.transaction(senderAccount, async () => {
      await zkApp.defaultReduce();
    });

    await tx.prove();
    await tx.sign([senderAccount.key]).send();

    let finalTotalSum = zkApp.totalSum.get();
    expect(finalTotalSum).toEqual(expectedTotal);

    // Do reduce second time, so we can check, that actions processed only once
    let tx2 = await Mina.transaction(senderAccount, async () => {
      await zkApp.defaultReduce();
    });

    await tx2.prove();
    await tx2.sign([senderAccount.key]).send();

    finalTotalSum = zkApp.totalSum.get();
    expect(finalTotalSum).toEqual(expectedTotal);
    console.log(`totalSum after first dispatch: ${finalTotalSum}`);

    // Dispatch more actions
    for (let i = 0; i < 5; i++) {
      let sender = others[i];
      let tx = await Mina.transaction(sender, async () => {
        await zkApp.add(Field(i));
      });

      await tx.prove();
      await tx.sign([sender.key]).send();

      expectedTotal = expectedTotal.add(Field(i));
    }

    let tx3 = await Mina.transaction(senderAccount, async () => {
      await zkApp.defaultReduce();
    });

    await tx3.prove();
    await tx3.sign([senderAccount.key]).send();

    finalTotalSum = zkApp.totalSum.get();
    expect(finalTotalSum).toEqual(expectedTotal);

    console.log(`totalSum after final dispatch: ${finalTotalSum}`);
  });

  it('correctly updates the totalSum with custom reducer', async () => {
    await localDeploy();

    const callCustomReduce = async () => {
      let curLatestProcessedState = zkApp.lastProcessedActionState.get();

      let actions = await zkApp.reducer.fetchActions({
        fromActionState: curLatestProcessedState,
      });

      let initPublicInput = new ReducePublicInput({
        value: zkApp.totalSum.get(),
      });

      let initPublicOutput = await init(
        initPublicInput,
        curLatestProcessedState
      );

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

          let publicOutput = await add(publicInput, curProof);

          curProof = await mockProof(publicOutput, ReduceProof, publicInput);
        }

        let cutPublicInput = new ReducePublicInput({
          value: Field(0), // Unused
        });

        let cutPublicOutput = await cutActions(cutPublicInput, curProof);

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

    let expectedTotal = Field(0);

    // Dispatch all actions
    for (let i = 0; i < 5; i++) {
      let sender = others[i];
      let tx = await Mina.transaction(sender, async () => {
        await zkApp.add(Field(i));
      });

      await tx.prove();
      await tx.sign([sender.key]).send();

      expectedTotal = expectedTotal.add(Field(i));
    }

    let curTotalSum = zkApp.totalSum.get();
    expect(curTotalSum).toEqual(Field(0));
    console.log(`Initial totalSum: ${curTotalSum}`);

    // Reduce
    await callCustomReduce();

    let finalTotalSum = zkApp.totalSum.get();
    expect(finalTotalSum).toEqual(expectedTotal);

    // Do reduce second time, so we can check, that actions processed only once
    let tx2 = await Mina.transaction(senderAccount, async () => {
      await zkApp.defaultReduce();
    });

    await tx2.prove();
    await tx2.sign([senderAccount.key]).send();

    finalTotalSum = zkApp.totalSum.get();
    expect(finalTotalSum).toEqual(expectedTotal);
    console.log(`totalSum after first dispatch: ${finalTotalSum}`);

    // Dispatch more actions
    for (let i = 0; i < 5; i++) {
      let sender = others[i];
      let tx = await Mina.transaction(sender, async () => {
        await zkApp.add(Field(i));
      });

      await tx.prove();
      await tx.sign([sender.key]).send();

      expectedTotal = expectedTotal.add(Field(i));
    }

    await callCustomReduce();

    finalTotalSum = zkApp.totalSum.get();
    expect(finalTotalSum).toEqual(expectedTotal);

    console.log(`totalSum after final dispatch: ${finalTotalSum}`);
  });
});
