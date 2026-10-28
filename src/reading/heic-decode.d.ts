declare module 'heic-decode' {
    interface DecodedImage {
        width: number;
        height: number;
        data: Uint8ClampedArray;
    }
    function decode(input: { buffer: Buffer | ArrayBuffer | Uint8Array }): Promise<DecodedImage>;
    export default decode;
}
