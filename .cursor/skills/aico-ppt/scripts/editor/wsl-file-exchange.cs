// WSL 的 Windows 挂载盘不提供 renameat2(RENAME_EXCHANGE)。
// 固化只替换既有文件，固定父目录链并保留旧文件；不使用普通覆盖重命名。
using System;
using System.IO;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class AicoFileExchange {
    [StructLayout(LayoutKind.Sequential)]
    struct FileInfo {
        public uint Attributes, CreatedLow, CreatedHigh, AccessLow, AccessHigh;
        public uint WriteLow, WriteHigh, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool ReplaceFileW(string replaced, string replacement, string backup, uint flags, IntPtr exclude, IntPtr reserved);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool MoveFileW(string from, string to);

    public static void Exchange(string directory, string left, string right, string expectedId) {
        var handles=new List<SafeFileHandle>();
        bool changed=false;
        try {
            directory=Path.GetFullPath(directory);
            if (directory.Length<3 || directory[1]!=':' || directory[2]!='\\') throw new IOException("只接受 Windows 本地卷目录");
            foreach(var name in new[]{left,right})
                if(String.IsNullOrEmpty(name) || name!=Path.GetFileName(name) || name=="." || name==".." || name.IndexOf(':')>=0)
                    throw new IOException("交换文件名无效");
            string current=Path.GetPathRoot(directory);
            var paths=new List<string>{current};
            foreach(var segment in directory.Substring(current.Length).Split(new[]{'\\'},StringSplitOptions.RemoveEmptyEntries)) {
                current=Path.Combine(current,segment);paths.Add(current);
            }
            FileInfo info=new FileInfo();
            foreach(var path in paths) {
                // 不共享删除：校验后不能重命名父目录，也拒绝 junction/symlink。
                var handle=CreateFileW(path,0x80,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
                if(handle.IsInvalid){handle.Dispose();throw new Win32Exception(Marshal.GetLastWin32Error());}
                handles.Add(handle);
                if(!GetFileInformationByHandle(handle,out info))throw new Win32Exception(Marshal.GetLastWin32Error());
                if((info.Attributes&0x10)==0 || (info.Attributes&0x400)!=0)throw new IOException("父目录不是可信真实目录");
            }
            ulong fileId=((ulong)info.IndexHigh<<32)|info.IndexLow;
            if(fileId.ToString()!=expectedId)throw new IOException("Windows 目录文件身份与 WSL dirfd 不一致："+fileId+" / "+expectedId);
            string candidate=Path.Combine(directory,left),target=Path.Combine(directory,right);
            foreach(var path in new[]{candidate,target}) {
                var attributes=File.GetAttributes(path);
                if((attributes&(FileAttributes.Directory|FileAttributes.ReparsePoint))!=0)throw new IOException("交换目标必须是普通文件");
            }
            string backup=Path.Combine(directory,".aico-exchange-"+Guid.NewGuid().ToString("N"));
            if(!ReplaceFileW(target,candidate,backup,0,IntPtr.Zero,IntPtr.Zero)) {
                int error=Marshal.GetLastWin32Error();
                changed=error==1177;
                throw new Win32Exception(error);
            }
            changed=true;
            // MoveFile 不覆盖已有条目；失败保留旧文件和外层持久事务供恢复。
            if(!MoveFileW(backup,candidate))throw new Win32Exception(Marshal.GetLastWin32Error());
        }catch(Exception error){error.Data["committed"]=changed;throw;}
        finally{for(int i=handles.Count-1;i>=0;i--)handles[i].Dispose();}
    }
}
