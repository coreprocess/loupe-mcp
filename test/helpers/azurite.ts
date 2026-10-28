import { BlobServiceClient } from '@azure/storage-blob';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

/** Azurite's well-known development account key. */
const KEY = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';

export interface Azurite {
    container: StartedTestContainer;
    connectionString: string;
    /** Creates a fresh blob container and returns its name. */
    createContainer(): Promise<string>;
}

export const startAzurite = async (): Promise<Azurite> => {
    const container = await new GenericContainer('mcr.microsoft.com/azure-storage/azurite')
        .withCommand(['azurite-blob', '--blobHost', '0.0.0.0', '--skipApiVersionCheck', '--loose'])
        .withExposedPorts(10000)
        .withWaitStrategy(Wait.forLogMessage(/Azurite Blob service successfully listens/))
        .start();
    const connectionString = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${KEY};BlobEndpoint=http://${container.getHost()}:${container.getMappedPort(10000)}/devstoreaccount1;`;
    let count = 0;
    return {
        container,
        connectionString,
        createContainer: async () => {
            const name = `store${++count}`;
            await BlobServiceClient.fromConnectionString(connectionString).getContainerClient(name).create();
            return name;
        },
    };
};
