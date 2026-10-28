// SPDX-License-Identifier: GPL-2.0
// AgentOS fixed telemetry probe (spec §18.1): process exec/exit for registered workload cgroups only.
// Fields: boot time, cgroup id, workload slot, pid/tgid, process start time, event kind, bounded exit code.
// No argv, environment, file content, network payload or unregistered process is ever collected.
#include <linux/bpf.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_core_read.h>

// Minimal CO-RE view of task_struct: libbpf relocates these fields against the running kernel's BTF.
struct task_struct {
	int pid;
	int tgid;
	int exit_code;
	__u64 start_time;
} __attribute__((preserve_access_index));

struct event {
	__u64 boot_ns;
	__u64 cgroup_id;
	__u64 start_time;
	__u32 slot;
	__u32 pid;
	__u32 tgid;
	__u32 kind; // 1 exec, 2 exit
	__s32 exit_code;
	__u32 pad;
};

struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	__uint(max_entries, 4 * 1024 * 1024);
} events SEC(".maps");

// cgroup id -> workload slot (filled by the collector from the trusted registry; bounded).
struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 256);
	__type(key, __u64);
	__type(value, __u32);
} workloads SEC(".maps");

// Ring reservation failures (kernel-side drops), per CPU.
struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, 1);
	__type(key, __u32);
	__type(value, __u64);
} drops SEC(".maps");

static __always_inline int emit(__u32 kind)
{
	__u64 cg = bpf_get_current_cgroup_id();
	__u32 *slot = bpf_map_lookup_elem(&workloads, &cg);
	if (!slot)
		return 0;
	struct event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
	if (!e) {
		__u32 k = 0;
		__u64 *d = bpf_map_lookup_elem(&drops, &k);
		if (d)
			__sync_fetch_and_add(d, 1);
		return 0;
	}
	struct task_struct *t = (struct task_struct *)bpf_get_current_task();
	e->boot_ns = bpf_ktime_get_boot_ns();
	e->cgroup_id = cg;
	e->slot = *slot;
	e->pid = BPF_CORE_READ(t, pid);
	e->tgid = BPF_CORE_READ(t, tgid);
	e->start_time = BPF_CORE_READ(t, start_time);
	e->kind = kind;
	e->exit_code = kind == 2 ? (BPF_CORE_READ(t, exit_code) & 0xffff) : 0;
	e->pad = 0;
	bpf_ringbuf_submit(e, 0);
	return 0;
}

SEC("tracepoint/sched/sched_process_exec")
int on_exec(void *ctx)
{
	return emit(1);
}

SEC("tracepoint/sched/sched_process_exit")
int on_exit(void *ctx)
{
	return emit(2);
}

char LICENSE[] SEC("license") = "GPL";
