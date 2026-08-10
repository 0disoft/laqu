import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time


def set_window_size(fd: int, rows: int, columns: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))


def read_until(fd: int, marker: bytes, timeout_seconds: float) -> bytes:
    deadline = time.monotonic() + timeout_seconds
    output = bytearray()
    while marker not in output:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(f"PTY output did not reach {marker!r}")
        readable, _, _ = select.select([fd], [], [], remaining)
        if not readable:
            continue
        try:
            output.extend(os.read(fd, 65536))
        except OSError as error:
            if error.errno == 5:
                break
            raise
    if marker not in output:
        raise EOFError(f"PTY closed before reaching {marker!r}")
    return bytes(output)


def wait_for_phase(fd: int, phase: bytes, timeout_seconds: float) -> None:
    deadline = time.monotonic() + timeout_seconds
    output = bytearray()
    while phase + b"\n" not in output:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(f"child did not reach phase {phase!r}")
        readable, _, _ = select.select([fd], [], [], remaining)
        if readable:
            output.extend(os.read(fd, 1024))


def main() -> None:
    node, child = sys.argv[1:3]
    master_fd, slave_fd = pty.openpty()
    phase_read_fd, phase_write_fd = os.pipe()
    set_window_size(slave_fd, 4, 40)
    environment = {**os.environ, "LAQU_PHASE_FD": str(phase_write_fd)}
    process = subprocess.Popen(
        [node, child],
        cwd=os.getcwd(),
        env=environment,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
        pass_fds=(phase_write_fd,),
    )
    os.close(slave_fd)
    os.close(phase_write_fd)

    try:
        wait_for_phase(phase_read_fd, b"initial", 10)
        initial = read_until(master_fd, b"__LAQU_INITIAL__", 10)

        set_window_size(master_fd, 2, 12)
        os.kill(process.pid, signal.SIGWINCH)
        os.write(master_fd, b"resize\n")
        wait_for_phase(phase_read_fd, b"resized", 10)
        resized = read_until(master_fd, b"__LAQU_RESIZED__", 10)
        os.write(master_fd, b"close\n")
        wait_for_phase(phase_read_fd, b"closed", 10)

        return_code = process.wait(timeout=10)
        if return_code != 0:
            raise RuntimeError(f"PTY child exited with {return_code}")
        print(
            json.dumps(
                {
                    "initial": base64.b64encode(initial).decode("ascii"),
                    "resized": base64.b64encode(resized).decode("ascii"),
                }
            )
        )
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        os.close(master_fd)
        os.close(phase_read_fd)


if __name__ == "__main__":
    main()
