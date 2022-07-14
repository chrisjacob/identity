import { Component, OnInit } from '@angular/core';
import { ethers } from 'ethers';
import {
  BackendAPIService,
  TransactionSpendingLimitResponse,
} from '../backend-api.service';
import { Network } from '../../types/identity';
import HDKey from 'hdkey';
import { ec } from 'elliptic';
import { CryptoService } from '../crypto.service';
import * as bs58check from 'bs58check';
import { getSpendingLimitsForMetamask } from '../log-in/log-in.component';
import { AccountService } from '../account.service';
import { IdentityService } from '../identity.service';
import { EntropyService } from '../entropy.service';
import { GoogleDriveService } from '../google-drive.service';
import { GlobalVarsService } from '../global-vars.service';
import { SigningService } from '../signing.service';
import { Router } from '@angular/router';
import {Transaction, TransactionMetadataAuthorizeDerivedKey} from '../../lib/deso/transaction';
enum SCREEN {
  CREATE_ACCOUNT = 0,
  LOADING = 1,
  ACCOUNT_SUCCESS = 2,
  AUTHORIZE_MESSAGES = 3,
  MESSAGES_SUCCESS = 4,
}
enum METAMASK {
  START = 0,
  CONNECT = 1,
  ERROR = 2,
}
@Component({
  selector: 'app-sign-up-metamask',
  templateUrl: './sign-up-metamask.component.html',
  styleUrls: ['./sign-up-metamask.component.scss'],
})
export class SignUpMetamaskComponent implements OnInit {
  private static UNLIMITED_DERIVED_KEY_EXPIRATION: Readonly<number> = 999999999999;
  private static TIMER_START_TIME: Readonly<number> = 15;
  metamaskState: METAMASK = METAMASK.START;
  currentScreen: SCREEN = SCREEN.CREATE_ACCOUNT;
  timer: any;
  SCREEN = SCREEN;
  METAMASK = METAMASK;
  timeoutTimer = SignUpMetamaskComponent.TIMER_START_TIME;
  publicKey = '';

  constructor(
    private accountService: AccountService,
    private identityService: IdentityService,
    private cryptoService: CryptoService,
    private entropyService: EntropyService,
    private googleDrive: GoogleDriveService,
    public globalVars: GlobalVarsService,
    private backendApi: BackendAPIService,
    private signingService: SigningService,
    private router: Router
  ) {}

  ngOnInit(): void {
    this.startTimer();
  }

  nextStep(): void {
    this.currentScreen += 1;
  }

  /**
   * STEP SCREEN_CREATE_ACCOUNT
   */

  launchMetamask(): void {
    this.signInWithMetamaskNewUser().catch((err) => {
      console.log('something went wrong with signing in through metamask', err);
      this.metamaskState = METAMASK.ERROR;
    });
  }

  public async connectMetamaskMiddleware(): Promise<boolean> {
    const accounts = await this.getProvider().listAccounts();
    if (accounts.length === 0) {
      return await this.getProvider()
        .send('eth_requestAccounts', [])
        .then(() => true)
        .catch((err) => {
          // EIP-1193 userRejectedRequest error.
          if (err.code === 4001) {
            console.error('user rejected the eth_requestAccounts request');
          } else {
            console.error('error while sending eth_requestAccounts:', err);
          }
          return false;
        });
    }
    return true;
  }

  public async verifySignatureAndRecoverAddress(
    message: number[],
    signature: string
  ): Promise<string> {
    const arrayify = ethers.utils.arrayify;
    const hash = ethers.utils.hashMessage;
    const recoveredAddress = ethers.utils.recoverAddress(
      arrayify(hash(message)),
      signature
    );
    const publicEthAddress = await this.getProvider().getSigner().getAddress();
    if (recoveredAddress !== publicEthAddress) {
      throw Error(
        "Public key recovered from signature doesn't match the signer's public key!"
      );
    }
    return recoveredAddress;
  }
  /**
   * Flow for new deso users looking to sign in with metamask
   */
  public async signInWithMetamaskNewUser(): Promise<any> {
    // generate a random derived key
    const network = this.globalVars.network;
    const expirationBlock =
      SignUpMetamaskComponent.UNLIMITED_DERIVED_KEY_EXPIRATION;
    const { keychain, mnemonic, derivedPublicKeyBase58Check, derivedKeyPair } =
      this.generateDerivedKey(network);

    this.metamaskState = METAMASK.CONNECT;
    const response = await this.connectMetamaskMiddleware();
    if (response !== true) {
      alert('something with wrong with metamask signin');
    }
    // fetch a spending limit hex string based off of the permissions you're allowing
    const getAccessBytesResponse = await this.backendApi
      .GetAccessBytes(
        derivedPublicKeyBase58Check,
        expirationBlock,
        getSpendingLimitsForMetamask() as TransactionSpendingLimitResponse
      )
      .toPromise();
    //  we can now generate the message and sign it
    const { message, signature } = await this.generateMessageAndSignature(
      derivedKeyPair,
      getAccessBytesResponse.AccessBytesHex
    );

    const publicEthAddress = await this.verifySignatureAndRecoverAddress(
      message,
      signature
    );
    // TODO: this needs backend's gringotts endpoint implemented.
    await this.getFundsForNewUsers(signature, message, publicEthAddress);
    // once we have the signature we can fetch the public key from it
    const metamaskKeyPair = this.getMetaMaskMasterPublicKeyFromSignature(
      signature,
      message
    );
    const metamaskPublicKey = Buffer.from(
      metamaskKeyPair.getPublic().encode('array', true)
    );
    const metamaskPublicKeyHex = metamaskPublicKey.toString('hex');
    const metamaskBtcAddress = this.cryptoService.publicKeyToBtcAddress(
      metamaskPublicKey,
      Network.mainnet
    );
    const metamaskEthAddress =
      this.cryptoService.publicKeyToEthAddress(metamaskKeyPair);
    const metamaskPublicKeyDeso = this.cryptoService.publicKeyToDeSoPublicKey(
      metamaskKeyPair,
      network
    );
    // Slice the '0x' prefix from the signature.
    const accessSignature = signature.slice(2);

    // we now have all the arguments to generate an authorize derived key transaction
    const authorizeDerivedKeyResponse = await this.backendApi
      .AuthorizeDerivedKey(
        metamaskPublicKeyDeso,
        derivedPublicKeyBase58Check,
        expirationBlock,
        accessSignature,
        getAccessBytesResponse.SpendingLimitHex
      )
      .toPromise();
    // Sanity-check the transaction contains all the information we passed.
    if (!this.verifyAuthorizeDerivedKeyTransaction(response.TransactionHex, derivedKeyPair,
      expirationBlock, accessSignature)) {
      console.error('Problem verifying authorized derived key transaction metadata');
      return;
    }
    // convert it to a byte array, sign it, submit it
    const signedTransactionHex = this.signingService.signTransaction(
      derivedKeyPair.getPrivate().toString('hex'),
      authorizeDerivedKeyResponse.TransactionHex,
      true
    );

    this.backendApi
      .SubmitTransaction(signedTransactionHex)
      .toPromise()
      .then((res) => {
        this.publicKey = this.accountService.addUserWithDepositAddresses(
          keychain,
          mnemonic,
          '',
          this.globalVars.network,
          metamaskBtcAddress,
          metamaskEthAddress,
          false,
          metamaskPublicKeyHex
        );
        this.currentScreen = this.SCREEN.ACCOUNT_SUCCESS;
        this.metamaskState = this.METAMASK.START;
        this.startTimer();
      });
  }

  private verifyAuthorizeDerivedKeyTransaction(transactionHex: string, derivedKeyPair: ec.KeyPair,
                                               expirationBlock: number, accessSignature: string): boolean {

    const txBytes = new Buffer(transactionHex, 'hex');
    const transaction = Transaction.fromBytes(txBytes)[0] as Transaction;

    // Make sure the transaction has the correct metadata.
    if (transaction.metadata?.constructor !== TransactionMetadataAuthorizeDerivedKey) {
      return false;
    }

    // Verify the metadata
    const transactionMetadata = transaction.metadata as TransactionMetadataAuthorizeDerivedKey;
    if (transactionMetadata.derivedPublicKey.toString('hex') !==
      derivedKeyPair.getPublic().encode('hex', true)) {
      return false;
    }
    if (transactionMetadata.expirationBlock !== expirationBlock) {
      return false;
    }
    if (transactionMetadata.operationType !== 1) {
      return false;
    }
    if (transactionMetadata.accessSignature.toString('hex') !== accessSignature) {
      return false;
    }

    // Verify the transaction outputs.
    for (const output of transaction.outputs) {
      if (output.publicKey.toString('hex') !== transaction.publicKey.toString('hex')) {
        return false;
      }
    }
    return true;
  }

  /**
   * @returns derivedPublicKeyBase58Check Base58 encoded derived public key
   * @returns derivedKeyPairKey pair object that handles the public private key logic for the derived key
   * Generates a new derived key
   */
  private generateDerivedKey(network: Network): {
    keychain: HDKey;
    mnemonic: string;
    derivedPublicKeyBase58Check: string;
    derivedKeyPair: ec.KeyPair;
  } {
    const e = new ec('secp256k1');
    this.entropyService.setNewTemporaryEntropy();
    const mnemonic = this.entropyService.temporaryEntropy.mnemonic;
    const keychain = this.cryptoService.mnemonicToKeychain(mnemonic);
    const prefix = CryptoService.PUBLIC_KEY_PREFIXES[network].deso;
    const derivedKeyPair = e.keyFromPrivate(keychain.privateKey); // gives us the keypair
    const desoKey = derivedKeyPair.getPublic().encode('array', true);
    const prefixAndKey = Uint8Array.from([...prefix, ...desoKey]);
    const derivedPublicKeyBase58Check = bs58check.encode(prefixAndKey);
    return {
      keychain,
      mnemonic,
      derivedPublicKeyBase58Check,
      derivedKeyPair,
    };
  }

  /**
   *
   * @param derivedKeyPair Key pair object that handles the public private key logic
   * @param spendingLimits determines what the derived key will be able to do for the user
   * @returns message: a byte array representation of the public key, expiration block for the derived key, and spending limits
   * @returns signature: the signed message by the derivedKeyPair object
   * generates a spending limits message and signature for authorizing a derived key
   */
  private generateMessageAndSignature(
    derivedKeyPair: ec.KeyPair,
    accessBytesHex: string
  ): Promise<{ message: number[]; signature: string }> {
    const numBlocksBeforeExpiration = 999999999999;

    // Access Bytes Encoding 1.0
    /*
        const derivedMessage = [
          ...ethers.utils.toUtf8Bytes(
            derivedKeyPair.getPublic().encode('hex', true)
          ),
          ...ethers.utils.toUtf8Bytes(
            uint64ToBufBigEndian(numBlocksBeforeExpiration).toString('hex')
          ),
          ...ethers.utils.toUtf8Bytes(spendingLimits),
        ];
    */

    // Access Bytes Encoding 2.0
    const message = [...Buffer.from(accessBytesHex, 'hex')];
    return new Promise<{ message: number[]; signature: string }>(
      (resolve, reject) => {
        this.getProvider()
          .getSigner()
          .signMessage(message)
          .then((signature) => {
            resolve({ message, signature });
          })
          .catch((err) => {
            reject(err);
          });
      }
    );
  }

  private getProvider = (): ethers.providers.Web3Provider => {
    const provider = new ethers.providers.Web3Provider(
      (window as any).ethereum
    );
    return provider;
  };

  public getFundsForNewUsers(
    signature: string,
    message: number[],
    publicAddress: string
  ): Promise<any> {
    // TODO: this needs to be added later
    return new Promise<any>((resolve, reject) => {
      resolve(true);
    });
  }

  /**
   *
   * @param signature a signature from the metamask account that we can extract the public key from
   * @param message the raw message that's included in the signature, needed to pull out the public key
   * @returns
   * extracts the public key from a signature and then encodes it to base58 aka a deso public key
   */
  public getMetaMaskMasterPublicKeyFromSignature(
    signature: string,
    message: number[]
  ): ec.KeyPair {
    const e = new ec('secp256k1');
    const arrayify = ethers.utils.arrayify;
    const messageHash = arrayify(ethers.utils.hashMessage(message));
    const publicKeyUncompressedHexWith0x = ethers.utils.recoverPublicKey(
      messageHash,
      signature
    );
    const metamaskPublicKey = e.keyFromPublic(
      publicKeyUncompressedHexWith0x.slice(2),
      'hex'
    );
    return metamaskPublicKey;
  }

  /**
   * STEP SCREEN_LOADING
   */
  private startTimer(): void {
    this.timer = setInterval(() => {
      if (this.timeoutTimer === 0) {
        this.stopTimer();
        this.login();
        return;
      }
      this.timeoutTimer--;
    }, 1000);
  }

  public login(): void {
    this.stopTimer();
    this.identityService.login({
      users: this.accountService.getEncryptedUsers(),
      publicKeyAdded: this.publicKey,
      signedUp: false,
    });
  }

  public stopTimer(): void {
    clearInterval(this.timer);
    this.timeoutTimer = SignUpMetamaskComponent.TIMER_START_TIME;
  }
  public continue(): void {
    this.stopTimer();
  }

  /**
   * STEP SCREEN_ACCOUNT_SUCCESS
   */

  /**
   * STEP SCREEN_AUTHORIZE_MESSAGES
   */

  /**
   * STEP SCREEN_MESSAGES_SUCCESS
   */
}
