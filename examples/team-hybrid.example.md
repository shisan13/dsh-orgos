# 多 bot 同群 + 人机混合 配置说明

权威模板(team-small/dept/group)已含人机混合岗位示例。

**多 bot 同群**:把多个 bot 拉进同一飞书群,@谁触发谁;routes 中同一 peerId 按 channel 区分:



真人与虚拟员工同群:真人岗位 occupant.kind: human(模板内已有示例),@bot 触发虚拟员工,直接 @真人 则真人应答。
