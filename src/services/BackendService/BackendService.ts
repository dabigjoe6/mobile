import {Buffer} from 'buffer';

import hmac256 from 'crypto-js/hmac-sha256';
import encHex from 'crypto-js/enc-hex';
import {TemporaryExposureKey} from 'bridge/ExposureNotification';
import nacl from 'tweetnacl';
import {getRandomBytes, downloadDiagnosisKeysFiles} from 'bridge/CovidShield';
import {utcISO8601Date} from 'shared/date-fns';
import {blobFetch} from 'shared/fetch';

import {covidshield} from './covidshield';
import {BackendInterface, SubmissionKeySet} from './types';

export class BackendService implements BackendInterface {
  retreiveUrl: string;
  submitUrl: string;
  hmacKey: string;

  constructor(retreiveUrl: string, submitUrl: string, hmacKey: string) {
    this.retreiveUrl = retreiveUrl;
    this.submitUrl = submitUrl;
    this.hmacKey = hmacKey;
  }

  async retrieveDiagnosisKeysByDay(date: Date) {
    const request = utcISO8601Date(date);
    const message = `${request}:${Math.floor(new Date().getTime() / 1000 / 3600)}`;
    const hmac = hmac256(message, encHex.parse(this.hmacKey)).toString(encHex);

    return downloadDiagnosisKeysFiles(`${this.retreiveUrl}/retrieve-day/${request}/${hmac}`);
  }

  async retrieveDiagnosisKeysByHour(date: Date, hour: number): Promise<string[]> {
    const hourFormatted = `0${hour}`.slice(-2);
    const request = `${utcISO8601Date(date)}`;
    const message = `${request}:${hourFormatted}:${Math.floor(new Date().getTime() / 1000 / 3600)}`;
    const hmac = hmac256(message, encHex.parse(this.hmacKey)).toString(encHex);

    return downloadDiagnosisKeysFiles(`${this.retreiveUrl}/retrieve-hour/${request}/${hourFormatted}/${hmac}`);
  }

  async getExposureConfiguration() {
    const region = 'ON';
    return (await fetch(`${this.retreiveUrl}/config/${region}/exposure.json`)).json();
  }

  async claimOneTimeCode(oneTimeCode: string): Promise<SubmissionKeySet> {
    const randomBytes = await getRandomBytes(32);
    nacl.setPRNG(buff => {
      buff.set(randomBytes, 0);
    });
    const keyPair = nacl.box.keyPair();

    const keyClaimResponse = await this.keyClaim(oneTimeCode, keyPair);
    if (keyClaimResponse.error) {
      throw new Error(`Code ${keyClaimResponse.error}`);
    }

    const serverPublicKey = Buffer.from(keyClaimResponse.serverPublicKey).toString('base64');
    const clientPrivateKey = Buffer.from(keyPair.secretKey).toString('base64');
    const clientPublicKey = Buffer.from(keyPair.publicKey).toString('base64');

    return {
      serverPublicKey,
      clientPrivateKey,
      clientPublicKey,
    };
  }

  async reportDiagnosisKeys(keyPair: SubmissionKeySet, exposureKeys: TemporaryExposureKey[]) {
    const upload = covidshield.Upload.create({
      timestamp: {seconds: Date.now()},
      keys: exposureKeys.map(key =>
        covidshield.Key.create({
          keyData: Buffer.from(key.keyData, 'base64'),
          rollingStartNumber: key.rollingStartNumber,
          transmissionRiskLevel: key.transmissionRiskLevel,
        }),
      ),
    });
    const serializedUpload = covidshield.Upload.encode(upload).finish();

    const clientPrivate = Buffer.from(keyPair.clientPrivateKey, 'base64');
    const serverPublicKey = Buffer.from(keyPair.serverPublicKey, 'base64');
    const clientPublicKey = Buffer.from(keyPair.clientPublicKey, 'base64');

    const nonce = await getRandomBytes(24);
    const encryptedPayload = nacl.box(serializedUpload, nonce, serverPublicKey, clientPrivate);

    await this.upload(encryptedPayload, nonce, serverPublicKey, clientPublicKey);
  }

  private async keyClaim(code: string, keyPair: nacl.BoxKeyPair): Promise<covidshield.KeyClaimResponse> {
    const uploadPayload = covidshield.KeyClaimRequest.create({
      oneTimeCode: code,
      appPublicKey: keyPair.publicKey,
    });

    const body = covidshield.KeyClaimRequest.encode(uploadPayload).finish();
    const buffer = await blobFetch(`${this.submitUrl}/claim-key`, 'POST', body);

    return covidshield.KeyClaimResponse.decode(Buffer.from(buffer));
  }

  private async upload(
    payload: Uint8Array,
    nonce: Uint8Array,
    serverPublicKey: Uint8Array,
    appPublicKey: Uint8Array,
  ): Promise<covidshield.EncryptedUploadResponse> {
    const request = covidshield.EncryptedUploadRequest.encode({
      serverPublicKey,
      appPublicKey,
      nonce,
      payload,
    }).finish();
    const arrayBuffer = await blobFetch(`${this.submitUrl}/upload`, 'POST', request);
    const response = covidshield.EncryptedUploadResponse.decode(Buffer.from(arrayBuffer));
    return response;
  }
}
