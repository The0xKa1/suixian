"""Own child lifetimes so cancelled uploads and service exits leave no engine."""
from __future__ import annotations

import subprocess
import threading
import time

from musicxml_reference import RecognitionError

STOPPING = threading.Event()
CHILDREN = set()
CHILDREN_LOCK = threading.Lock()
REQUEST = threading.local()


class RecognitionCancelled(RecognitionError):
    pass


def check_cancelled():
    disconnected = getattr(REQUEST, "disconnected", None)
    if STOPPING.is_set() or (disconnected is not None and disconnected()):
        raise RecognitionCancelled("识谱已取消。")


def stop_process(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)


def stop_children():
    STOPPING.set()
    with CHILDREN_LOCK:
        children = list(CHILDREN)
    for process in children:
        stop_process(process)


def run_local(command, *, timeout=30, capture_output=False, **kwargs):
    check_cancelled()
    if capture_output:
        kwargs["stdout"] = subprocess.PIPE
        kwargs["stderr"] = subprocess.PIPE
    process = subprocess.Popen(command, **kwargs)
    with CHILDREN_LOCK:
        CHILDREN.add(process)
    deadline = time.monotonic() + timeout
    try:
        while True:
            check_cancelled()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(command, timeout)
            try:
                stdout, stderr = process.communicate(timeout=min(.15, remaining))
                return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
            except subprocess.TimeoutExpired:
                pass
    finally:
        stop_process(process)
        with CHILDREN_LOCK:
            CHILDREN.discard(process)
