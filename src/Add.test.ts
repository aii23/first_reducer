import { AccountUpdate, Field, Mina, PrivateKey, PublicKey } from 'o1js';
import { Add } from './Add';

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
});
