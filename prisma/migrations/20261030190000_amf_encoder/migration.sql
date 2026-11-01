-- AMD graphics' H.264 encoder, which the worker picks after NVENC and before x264.
ALTER TYPE "VideoEncoder" ADD VALUE 'amf' BEFORE 'x264';
