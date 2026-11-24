'use server'

import { randomBytes } from 'crypto'
import { createClient } from '@/utils/supabase/server'
import { createServiceRoleClient } from '@/utils/supabase/service'
import { revalidatePath } from 'next/cache'

export async function createEmployeeAction(formData: any, branchId: string) {
    try {
        // Only signed-in admins may create accounts. This action runs with the
        // service role, so it must check the caller itself.
        const authClient = await createClient()
        const { data: { user } } = await authClient.auth.getUser()
        if (!user) {
            return { error: 'Unauthorized' }
        }
        const { data: callerProfile } = await authClient
            .from('profiles')
            .select('role')
            .eq('id', user.id)
            .single()
        const callerRole = callerProfile?.role
        if (!['super_admin', 'admin', 'branch_admin'].includes(callerRole)) {
            return { error: 'Only admins can create employee accounts' }
        }

        // New accounts can only get the roles the form offers.
        const allowedRoles = ['staff', 'branch_admin']
        const newRole = allowedRoles.includes(formData?.role) ? formData.role : 'staff'

        const supabase = createServiceRoleClient()

        // 1. Create Auth User with a one-time random password (shown once to the admin).
        const tempPassword = randomBytes(12).toString('base64url')

        const { data: userData, error: userError } = await supabase.auth.admin.createUser({
            email: formData.email,
            password: tempPassword,
            email_confirm: true,
            user_metadata: { full_name: formData.full_name }
        })

        if (userError) {
            console.error('Auth Create Error:', userError)
            return { error: userError.message }
        }

        const userId = userData.user.id

        // 2. Upsert Profile
        const { error: profileError } = await supabase.from('profiles').upsert({
            id: userId,
            full_name: formData.full_name,
            phone: formData.phone,
            role: newRole,
            is_active: true,
            updated_at: new Date().toISOString()
        })

        if (profileError) {
            await supabase.auth.admin.deleteUser(userId)
            return { error: `Profile Creation Failed: ${profileError.message}` }
        }

        // 3. Assign to Branch
        const { error: branchError } = await supabase.from('user_branch_assignments').insert({
            user_id: userId,
            branch_id: branchId,
            is_primary: true
        })

        if (branchError) {
            return { error: `Branch Assignment Failed: ${branchError.message}` }
        }

        // 4. Create Employee Profile
        const { error: empError } = await supabase.from('employee_profiles').insert({
            id: userId,
            employee_id: formData.employee_id,
            department: formData.department,
            position: formData.position,
            employment_type: formData.employment_type,
            date_hired: formData.date_hired,
            base_salary: parseFloat(formData.base_salary) || 0,
            employment_status: 'Active'
        })

        if (empError) {
            return { error: `Employee Detail Failed: ${empError.message}` }
        }

        return { success: true, tempPassword }

    } catch (e: any) {
        return { error: e.message }
    }
}
