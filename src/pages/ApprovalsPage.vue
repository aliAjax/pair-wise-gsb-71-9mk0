<script setup lang="ts">
import { ref } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Message } from '@arco-design/web-vue'
import { getRuns, mergeRuns } from '@/api/http'
import StatusTag from '@/components/StatusTag.vue'
import type { ScreenshotRun } from '@/types'

const queryClient = useQueryClient()
const selectedKeys = ref<string[]>([])

const { data: runs, isLoading } = useQuery({
  queryKey: ['runs', { status: 'pending' }],
  queryFn: () => getRuns({ status: 'pending' }),
})

const mergeMutation = useMutation({
  mutationFn: mergeRuns,
  onSuccess: async () => {
    Message.success('重复运行已合并，并保留每次执行来源')
    selectedKeys.value = []
    await queryClient.invalidateQueries({ queryKey: ['runs'] })
  },
  onError: (error: Error) => Message.error(error.message),
})

const unignoredCount = (run: ScreenshotRun) =>
  run.regions.filter((region) => !region.ignored).length
</script>

<template>
  <section class="page-intro compact">
    <div>
      <h2>待审批队列</h2>
      <p>审批人不能直接覆盖基线；批准、驳回和忽略都必须留下可审计原因。</p>
    </div>
    <a-space>
      <a-button :disabled="selectedKeys.length < 2" @click="mergeMutation.mutate(selectedKeys)">
        <icon-merge /> 合并重复运行
      </a-button>
      <a-button type="primary" :disabled="selectedKeys.length === 0" @click="selectedKeys = []">
        清除选择
      </a-button>
    </a-space>
  </section>

  <div class="queue-summary">
    <div>
      <span>当前待审批</span>
      <strong>{{ runs?.length ?? 0 }}</strong>
    </div>
    <div>
      <span>高风险运行</span>
      <strong class="danger">{{ runs?.filter((run) => run.mismatchRate >= 5).length ?? 0 }}</strong>
    </div>
    <div>
      <span>可合并运行</span>
      <strong>2 组</strong>
    </div>
    <div>
      <span>预计阻塞时间</span>
      <strong>43 分钟</strong>
    </div>
  </div>

  <a-card class="table-panel" :bordered="false">
    <a-table
      v-model:selected-keys="selectedKeys"
      :data="runs"
      :loading="isLoading"
      :pagination="false"
      row-key="id"
      :row-selection="{ type: 'checkbox', showCheckedAll: true }"
    >
      <template #columns>
        <a-table-column title="优先队列" :width="260">
          <template #cell="{ record }">
            <div class="primary-cell">
              <router-link :to="`/runs/${record.id}`">{{ record.page }}</router-link>
              <span>{{ record.name }} · {{ record.id }}</span>
            </div>
          </template>
        </a-table-column>
        <a-table-column title="风险" :width="130">
          <template #cell="{ record }">
            <a-tag :color="record.mismatchRate >= 5 ? 'red' : record.mismatchRate >= 2 ? 'orange' : 'gray'">
              {{ record.mismatchRate.toFixed(2) }}%
            </a-tag>
          </template>
        </a-table-column>
        <a-table-column title="差异区域" :width="150">
          <template #cell="{ record }">{{ unignoredCount(record) }} 处待判定</template>
        </a-table-column>
        <a-table-column title="构建" data-index="build" :width="180" />
        <a-table-column title="提交时间" :width="150">
          <template #cell="{ record }">{{ record.capturedAt.slice(5, 16).replace('T', ' ') }}</template>
        </a-table-column>
        <a-table-column title="状态" :width="100">
          <template #cell="{ record }"><StatusTag :status="record.status" /></template>
        </a-table-column>
        <a-table-column title="操作" :width="100" fixed="right">
          <template #cell="{ record }"><router-link :to="`/runs/${record.id}`">开始评审</router-link></template>
        </a-table-column>
      </template>
    </a-table>
  </a-card>
</template>
