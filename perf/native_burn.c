#define _GNU_SOURCE
#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

/* ------------------------------------------------------------------ */
/* Result struct — 24 bytes, naturally aligned for double              */
/* ------------------------------------------------------------------ */

typedef struct {
    double   pi;           /* offset  0 */
    int64_t  iterations;   /* offset  8 */
    int32_t  thread_id;    /* offset 16 */
    int32_t  _pad;         /* offset 20 — alignment padding */
} ThreadResult;

/* ------------------------------------------------------------------ */
/* Per-thread work descriptor                                         */
/* ------------------------------------------------------------------ */

typedef struct {
    int32_t        thread_id;
    int32_t        duration_ms;
    int32_t        memory_mb;
    int32_t        _pad;
    ThreadResult  *result;
} ThreadWork;

/* ------------------------------------------------------------------ */
/* Thread entry point                                                 */
/* ------------------------------------------------------------------ */

static void *burn_thread(void *arg) {
    ThreadWork *work = (ThreadWork *)arg;

    /* Phase 1 — Memory pressure: allocate + touch every page */
    int64_t target_bytes = (int64_t)work->memory_mb * 1024 * 1024;
    char *mem = NULL;
    if (target_bytes > 0) {
        mem = (char *)malloc((size_t)target_bytes);
        if (mem) {
            for (int64_t i = 0; i < target_bytes; i += 4096)
                mem[i] = (char)(i & 0xFF);
        }
    }

    /* Phase 2 — CPU burn: Leibniz series for π */
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    int64_t end_ms = ts.tv_sec * 1000 + ts.tv_nsec / 1000000 + work->duration_ms;

    double  sum  = 0.0;
    int64_t k    = 0;
    int64_t iters = 0;

    for (;;) {
        for (int batch = 0; batch < 500000; batch++) {
            sum += (k & 1 ? -1.0 : 1.0) / (2.0 * (double)k + 1.0);
            k++;
        }
        iters += 500000;

        clock_gettime(CLOCK_MONOTONIC, &ts);
        if (ts.tv_sec * 1000 + ts.tv_nsec / 1000000 >= end_ms) break;
    }

    /* Write result */
    work->result->pi         = sum * 4.0;
    work->result->iterations = iters;
    work->result->thread_id  = work->thread_id;

    if (mem) free(mem);
    return NULL;
}

/* ================================================================== */
/* Exported symbols                                                   */
/* ================================================================== */

/* Number of online hardware threads (cgroup-aware on Linux) */
int32_t get_hw_threads(void) {
    return (int32_t)sysconf(_SC_NPROCESSORS_ONLN);
}

/* sizeof(ThreadResult) so JS can allocate the right buffer size */
int32_t result_struct_size(void) {
    return (int32_t)sizeof(ThreadResult);
}

/*
 * Spawn `num_threads` native pthreads, each burning CPU for
 * `duration_ms` and allocating `mem_mb` of memory.
 * Results are written into the caller-provided buffer.
 */
int32_t native_burn(int32_t num_threads,
                    int32_t duration_ms,
                    int32_t mem_mb,
                    void   *results_ptr)
{
    pthread_t  *threads = (pthread_t *)malloc(sizeof(pthread_t)  * (size_t)num_threads);
    ThreadWork *works   = (ThreadWork *)malloc(sizeof(ThreadWork) * (size_t)num_threads);

    if (!threads || !works) { free(threads); free(works); return -1; }

    ThreadResult *results = (ThreadResult *)results_ptr;

    for (int i = 0; i < num_threads; i++) {
        works[i].thread_id   = i;
        works[i].duration_ms = duration_ms;
        works[i].memory_mb   = mem_mb;
        works[i]._pad        = 0;
        works[i].result      = &results[i];
        pthread_create(&threads[i], NULL, burn_thread, &works[i]);
    }

    for (int i = 0; i < num_threads; i++)
        pthread_join(threads[i], NULL);

    free(threads);
    free(works);
    return 0;
}
